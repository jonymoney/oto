import { Pool } from 'pg'
import { config } from './config.js'
import type { AudioRecord, NewAudio } from './types.js'

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
      unique (user_id, text_hash)
    )
  `)
  await pool.query(`
    create index if not exists audios_user_id_created_at_idx
      on audios (user_id, created_at desc)
  `)
}

export async function closeDb(): Promise<void> {
  await pool.end()
}

const COLUMNS =
  'id, user_id, text_hash, text, title, voice, model, format, object_key, duration_sec, char_count, created_at'

export const audioRepo = {
  async findByHash(userId: string, textHash: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `select ${COLUMNS} from audios where user_id = $1 and text_hash = $2`,
      [userId, textHash],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  async insert(audio: NewAudio): Promise<AudioRecord> {
    const { rows } = await pool.query<AudioRow>(
      `insert into audios
         (user_id, text_hash, text, title, voice, model, format, object_key, duration_sec, char_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      ],
    )
    if (rows[0]) return mapRow(rows[0])
    // Lost a generate-once race: another request inserted the same
    // (user_id, text_hash) first — return that row.
    const existing = await this.findByHash(audio.userId, audio.textHash)
    if (!existing) {
      throw new Error(
        `audios insert conflicted but no row found for user ${audio.userId}, hash ${audio.textHash}`,
      )
    }
    return existing
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
}
