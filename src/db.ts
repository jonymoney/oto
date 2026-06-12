import { Pool } from 'pg'
import { config } from './config.js'
import type { AudioRecord, AudioStatus, NewAudio } from './types.js'

interface AudioRow {
  id: string
  user_id: string
  text_hash: string
  text: string
  title: string
  voice: string
  model: string
  format: string
  object_key: string
  duration_sec: string | null
  char_count: number
  created_at: Date | string
  status: AudioStatus
  chunks_total: number | null
  chunks_done: number
  error_message: string | null
}

function mapRow(row: AudioRow): AudioRecord {
  return {
    id: row.id,
    userId: row.user_id,
    textHash: row.text_hash,
    text: row.text,
    title: row.title,
    voice: row.voice,
    model: row.model,
    format: row.format,
    objectKey: row.object_key,
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    charCount: row.char_count,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    status: row.status,
    chunksTotal: row.chunks_total,
    chunksDone: row.chunks_done,
    errorMessage: row.error_message,
  }
}

// Railway's private network has no TLS; its public proxy uses a self-signed
// cert — so TLS (without CA verification) only for non-local, non-internal hosts.
function sslFor(databaseUrl: string): { rejectUnauthorized: false } | undefined {
  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch {
    return undefined
  }
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
    return undefined
  }
  return { rejectUnauthorized: false }
}

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  ssl: sslFor(config.DATABASE_URL),
})

// Without a listener, an error on an idle pooled connection crashes the process.
pool.on('error', (err) => {
  console.error('Postgres pool error (idle client):', err)
})

export async function initDb(): Promise<void> {
  await pool.query(`
    create table if not exists audios (
      id           uuid primary key default gen_random_uuid(),
      user_id      uuid not null,
      text_hash    text not null,
      text         text not null,
      title        text not null,
      voice        text not null,
      model        text not null,
      format       text not null default 'mp3',
      object_key   text not null,
      duration_sec numeric,
      char_count   int not null,
      created_at   timestamptz not null default now(),
      status        text not null default 'ready',
      chunks_total  int,
      chunks_done   int not null default 0,
      error_message text,
      updated_at    timestamptz not null default now(),
      unique (user_id, text_hash)
    )
  `)
  // Migrate the pre-async production table in place (no-ops on fresh installs).
  await pool.query(`
    alter table audios
      add column if not exists status text not null default 'ready',
      add column if not exists chunks_total int,
      add column if not exists chunks_done int not null default 0,
      add column if not exists error_message text,
      add column if not exists updated_at timestamptz not null default now()
  `)
  await pool.query(`
    create index if not exists audios_user_id_created_at_idx
      on audios (user_id, created_at desc)
  `)
  // Monotonic per-user generation usage: only real OpenAI generations add to
  // it; deleting audios or replaying stored ones never decreases it.
  await pool.query(`
    create table if not exists usage_counters (
      user_id       uuid primary key,
      email         text,
      generated_sec numeric not null default 0,
      unlimited     boolean not null default false,
      updated_at    timestamptz not null default now()
    )
  `)
}

export async function closeDb(): Promise<void> {
  await pool.end()
}

const COLUMNS =
  'id, user_id, text_hash, text, title, voice, model, format, object_key, duration_sec, char_count, created_at, status, chunks_total, chunks_done, error_message'

export const audioRepo = {
  async findByHash(userId: string, textHash: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `select ${COLUMNS} from audios where user_id = $1 and text_hash = $2`,
      [userId, textHash],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  /**
   * Inserts the audio row, or returns the existing one on a generate-once
   * conflict. `created` tells the caller whether it owns the row — only the
   * creator may start a background job (prevents double generation/charging).
   */
  async insert(audio: NewAudio): Promise<{ rec: AudioRecord; created: boolean }> {
    const { rows } = await pool.query<AudioRow>(
      `insert into audios
         (user_id, text_hash, text, title, voice, model, format, object_key, duration_sec, char_count,
          status, chunks_total, chunks_done, error_message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (user_id, text_hash) do nothing
       returning ${COLUMNS}`,
      [
        audio.userId,
        audio.textHash,
        audio.text,
        audio.title,
        audio.voice,
        audio.model,
        audio.format,
        audio.objectKey,
        audio.durationSec,
        audio.charCount,
        audio.status,
        audio.chunksTotal,
        audio.chunksDone,
        audio.errorMessage,
      ],
    )
    if (rows[0]) return { rec: mapRow(rows[0]), created: true }
    // Lost a generate-once race: another request inserted the same
    // (user_id, text_hash) first — return that row.
    const existing = await this.findByHash(audio.userId, audio.textHash)
    if (!existing) {
      throw new Error(
        `audios insert conflicted but no row found for user ${audio.userId}, hash ${audio.textHash}`,
      )
    }
    return { rec: existing, created: false }
  },

  async getById(userId: string, id: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `select ${COLUMNS} from audios where user_id = $1 and id = $2`,
      [userId, id],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  async listByUser(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ items: AudioRecord[]; total: number }> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200)
    const safeOffset = Math.max(Math.floor(offset), 0)
    const [listResult, countResult] = await Promise.all([
      pool.query<AudioRow>(
        `select ${COLUMNS} from audios
         where user_id = $1
         order by created_at desc, id desc
         limit $2 offset $3`,
        [userId, safeLimit, safeOffset],
      ),
      pool.query<{ total: string }>('select count(*)::text as total from audios where user_id = $1', [
        userId,
      ]),
    ])
    return {
      items: listResult.rows.map(mapRow),
      total: Number(countResult.rows[0]?.total ?? 0),
    }
  },

  async deleteById(userId: string, id: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `delete from audios where user_id = $1 and id = $2 returning ${COLUMNS}`,
      [userId, id],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  async markChunkDone(id: string): Promise<void> {
    await pool.query(
      'update audios set chunks_done = chunks_done + 1, updated_at = now() where id = $1',
      [id],
    )
  },

  async markReady(id: string, durationSec: number | null): Promise<void> {
    await pool.query(
      `update audios
          set status = 'ready', duration_sec = $2, error_message = null, updated_at = now()
        where id = $1`,
      [id, durationSec],
    )
  },

  async markError(id: string, message: string): Promise<void> {
    await pool.query(
      `update audios set status = 'error', error_message = $2, updated_at = now() where id = $1`,
      [id, message],
    )
  },

  /**
   * Lazy janitor: a row still 'processing' 15+ minutes after its last progress
   * update is presumed dead (job crashed or the process restarted). Flips it to
   * 'error' atomically — the WHERE re-checks status/updated_at so a live job
   * can't be clobbered — and returns the updated row, or `rec` unchanged.
   */
  async resolveStale(rec: AudioRecord): Promise<AudioRecord> {
    if (rec.status !== 'processing') return rec
    const { rows } = await pool.query<AudioRow>(
      `update audios
          set status = 'error', error_message = 'generation timed out', updated_at = now()
        where id = $1 and status = 'processing'
          and updated_at < now() - interval '15 minutes'
        returning ${COLUMNS}`,
      [rec.id],
    )
    return rows[0] ? mapRow(rows[0]) : rec
  },
}

export const usageRepo = {
  /** Cumulative seconds of audio this user has had generated (never decreases). */
  async generatedSec(userId: string): Promise<number> {
    const { rows } = await pool.query<{ generated_sec: string }>(
      'select generated_sec::text from usage_counters where user_id = $1',
      [userId],
    )
    return rows[0] ? Number(rows[0].generated_sec) : 0
  },

  /** True when this user has the per-user unlimited-generation flag. */
  async isUnlimited(userId: string): Promise<boolean> {
    const { rows } = await pool.query<{ unlimited: boolean }>(
      'select unlimited from usage_counters where user_id = $1',
      [userId],
    )
    return rows[0]?.unlimited ?? false
  },

  async addGeneratedSec(userId: string, seconds: number, email?: string): Promise<void> {
    await pool.query(
      `insert into usage_counters (user_id, email, generated_sec, updated_at)
       values ($1, $2, $3, now())
       on conflict (user_id)
       do update set generated_sec = usage_counters.generated_sec + excluded.generated_sec,
                     email = coalesce(excluded.email, usage_counters.email),
                     updated_at = now()`,
      [userId, email ?? null, seconds],
    )
  },
}
