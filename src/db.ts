import { Pool } from 'pg'
import { config } from './config.js'
import type { AudioRecord, AudioStatus, NewAudio } from './types.js'

interface AudioRow {
  id: string
  user_id: string
  text_hash: string
  text: string
  title: string
  summary: string | null
  emoji: string | null
  language: string | null
  mood: string | null
  tags: string[] | null
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
  slug: string | null
}

function mapRow(row: AudioRow): AudioRecord {
  return {
    id: row.id,
    userId: row.user_id,
    textHash: row.text_hash,
    text: row.text,
    title: row.title,
    summary: row.summary,
    emoji: row.emoji,
    language: row.language,
    mood: row.mood,
    tags: row.tags ?? [],
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
    slug: row.slug,
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

// Exported so Better Auth (src/better-auth.ts) shares this one pool.
export const pool = new Pool({
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
      summary      text,
      emoji        text,
      language     text,
      mood         text,
      tags         text[] not null default '{}',
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
      add column if not exists updated_at timestamptz not null default now(),
      add column if not exists summary text,
      add column if not exists emoji text,
      add column if not exists language text,
      add column if not exists mood text,
      add column if not exists tags text[] not null default '{}',
      add column if not exists slug text
  `)
  // Short share links: slug unique per user (nulls exempt — lazily backfilled).
  await pool.query(`
    create unique index if not exists audios_user_slug_idx
      on audios (user_id, slug) where slug is not null
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
  // Stripe billing columns (no-op once applied).
  await pool.query(`
    alter table usage_counters
      add column if not exists stripe_customer_id  text,
      add column if not exists subscription_status text
  `)
  // Short share links: username on the Better Auth `users` table. Guarded —
  // that table only exists after `npx @better-auth/cli migrate`.
  const { rows: usersReg } = await pool.query<{ reg: string | null }>(
    "select to_regclass('public.users') as reg",
  )
  if (usersReg[0]?.reg) {
    await pool.query('alter table users add column if not exists username text')
    await pool.query(
      'create unique index if not exists users_username_idx on users (username) where username is not null',
    )
  }
  await seedBetterAuthUsers()
}

// One-time bridge from the former Supabase auth users. Each row keeps its
// original Supabase UUID so existing audios.user_id / usage_counters.user_id
// stay valid with zero remap; email is the identity Better Auth signs in with.
// Both accounts were email-confirmed in Supabase (no phone), so emailVerified=true.
const SUPABASE_USER_SEED: ReadonlyArray<{ id: string; email: string }> = [
  { id: '491ec598-f454-4ef7-a5b3-f0d1660bd823', email: 'ijonathanvs@gmail.com' },
  { id: '638ad8c6-f387-467e-b7c0-16d7f17da1e3', email: 'iam@jony.money' },
]

/**
 * Seeds the Better Auth `users` table from the Supabase export. Idempotent
 * (on conflict do nothing). No-ops until `npx @better-auth/cli migrate` has
 * created the Better Auth schema, so boot order never matters.
 */
async function seedBetterAuthUsers(): Promise<void> {
  const { rows } = await pool.query<{ reg: string | null }>(
    "select to_regclass('public.users') as reg",
  )
  if (!rows[0]?.reg) {
    console.warn('Better Auth `users` table missing — run `npx @better-auth/cli migrate`; skipping user seed')
    return
  }
  for (const u of SUPABASE_USER_SEED) {
    await pool.query(
      `insert into users (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, true, now(), now())
       on conflict do nothing`,
      [u.id, u.email, u.email],
    )
  }
}

export async function closeDb(): Promise<void> {
  await pool.end()
}

const COLUMNS =
  'id, user_id, text_hash, text, title, summary, emoji, language, mood, tags, voice, model, format, object_key, duration_sec, char_count, created_at, status, chunks_total, chunks_done, error_message, slug'

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
         (user_id, text_hash, text, title, summary, emoji, language, mood, tags,
          voice, model, format, object_key, duration_sec, char_count,
          status, chunks_total, chunks_done, error_message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       on conflict (user_id, text_hash) do nothing
       returning ${COLUMNS}`,
      [
        audio.userId,
        audio.textHash,
        audio.text,
        audio.title,
        audio.summary,
        audio.emoji,
        audio.language,
        audio.mood,
        audio.tags,
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

  /** Unscoped lookup for public share pages — the unguessable UUID is the capability. */
  async getByIdPublic(id: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(`select ${COLUMNS} from audios where id = $1`, [id])
    return rows[0] ? mapRow(rows[0]) : null
  },

  /** Short-link lookup for public share pages: /:username/:slug → (user_id, slug). */
  async getBySlugPublic(userId: string, slug: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `select ${COLUMNS} from audios where user_id = $1 and slug = $2`,
      [userId, slug],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  async slugTaken(userId: string, slug: string): Promise<boolean> {
    const { rows } = await pool.query(
      'select 1 from audios where user_id = $1 and slug = $2 limit 1',
      [userId, slug],
    )
    return rows.length > 0
  },

  /** Throws on a (user_id, slug) unique collision — caller retries with a suffix. */
  async setSlug(id: string, slug: string): Promise<void> {
    await pool.query('update audios set slug = $2 where id = $1', [id, slug])
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

// Better Auth owns the `users` table; oto only reads it + manages `username`.
export const userRepo = {
  async get(userId: string): Promise<{ email: string; username: string | null } | null> {
    const { rows } = await pool.query<{ email: string; username: string | null }>(
      'select email, username from users where id = $1',
      [userId],
    )
    return rows[0] ?? null
  },

  /**
   * Claims a username iff the user has none yet. False = someone else claimed
   * concurrently (re-read to get theirs); throws on a unique-index collision.
   */
  async claimUsername(userId: string, username: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      'update users set username = $2 where id = $1 and username is null',
      [userId, username],
    )
    return (rowCount ?? 0) > 0
  },

  async findIdByUsername(username: string): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      'select id from users where username = $1',
      [username],
    )
    return rows[0]?.id ?? null
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

  /** Flip the per-user unlimited flag (upserts the row if it doesn't exist yet). */
  async setUnlimited(userId: string, unlimited: boolean): Promise<void> {
    await pool.query(
      `insert into usage_counters (user_id, unlimited, updated_at)
       values ($1, $2, now())
       on conflict (user_id)
       do update set unlimited = excluded.unlimited, updated_at = now()`,
      [userId, unlimited],
    )
  },

  /** Record the Stripe customer id for this user (upserts). */
  async linkStripeCustomer(userId: string, customerId: string): Promise<void> {
    await pool.query(
      `insert into usage_counters (user_id, stripe_customer_id, updated_at)
       values ($1, $2, now())
       on conflict (user_id)
       do update set stripe_customer_id = excluded.stripe_customer_id, updated_at = now()`,
      [userId, customerId],
    )
  },

  /** Update subscription status + unlimited for the row matching a Stripe customer. */
  async setSubscriptionStatus(customerId: string, status: string, unlimited: boolean): Promise<void> {
    await pool.query(
      `update usage_counters
          set subscription_status = $2, unlimited = $3, updated_at = now()
        where stripe_customer_id = $1`,
      [customerId, status, unlimited],
    )
  },

  async findByStripeCustomer(customerId: string): Promise<{ userId: string } | null> {
    const { rows } = await pool.query<{ user_id: string }>(
      'select user_id from usage_counters where stripe_customer_id = $1',
      [customerId],
    )
    return rows[0] ? { userId: rows[0].user_id } : null
  },
}
