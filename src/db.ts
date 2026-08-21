import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { config } from './config.js'
import type { AudioRecord, AudioStatus, NewAudio, Visibility } from './types.js'

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
  client_name: string | null
  object_key: string
  duration_sec: string | null
  char_count: number
  created_at: Date | string
  status: AudioStatus
  chunks_total: number | null
  chunks_done: number
  error_message: string | null
  slug: string | null
  position_sec: number | null
  played_at: Date | string | null
  visibility: Visibility
  plays: number
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
    clientName: row.client_name,
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
    positionSec: row.position_sec === null ? null : Number(row.position_sec),
    playedAt:
      row.played_at === null
        ? null
        : row.played_at instanceof Date
          ? row.played_at.toISOString()
          : new Date(row.played_at).toISOString(),
    visibility: row.visibility,
    plays: row.plays,
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
      add column if not exists slug text,
      add column if not exists position_sec double precision,
      add column if not exists played_at timestamptz,
      add column if not exists visibility text not null default 'private',
      add column if not exists client_name text,
      add column if not exists plays integer not null default 0
  `)
  // Social graph + saves + collections (user ids match audios.user_id: uuid).
  await pool.query(`
    create table if not exists follows (
      follower_id uuid not null,
      followee_id uuid not null,
      created_at  timestamptz not null default now(),
      primary key (follower_id, followee_id)
    )
  `)
  await pool.query(`
    create table if not exists saved_audios (
      user_id    uuid not null,
      audio_id   uuid not null references audios(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (user_id, audio_id)
    )
  `)
  await pool.query(`
    create table if not exists collections (
      id         uuid primary key default gen_random_uuid(),
      user_id    uuid not null,
      name       text not null,
      created_at timestamptz not null default now()
    )
  `)
  await pool.query(
    'alter table collections add column if not exists is_default boolean not null default false',
  )
  // At most one default collection per user — makes lazy creation race-safe.
  await pool.query(
    'create unique index if not exists collections_user_default_idx on collections (user_id) where is_default',
  )
  await pool.query(`
    create table if not exists collection_items (
      collection_id uuid not null references collections(id) on delete cascade,
      audio_id      uuid not null references audios(id) on delete cascade,
      added_at      timestamptz not null default now(),
      primary key (collection_id, audio_id)
    )
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
  // Per-user generation preferences (null = server default).
  await pool.query(`
    create table if not exists user_prefs (
      user_id    uuid primary key,
      voice      text,
      provider   text,
      updated_at timestamptz not null default now()
    )
  `)
  await pool.query('alter table user_prefs add column if not exists language text')
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
  'id, user_id, text_hash, text, title, summary, emoji, language, mood, tags, voice, model, format, client_name, object_key, duration_sec, char_count, created_at, status, chunks_total, chunks_done, error_message, slug, position_sec, played_at, visibility, plays'

/** COLUMNS qualified with a table alias, for joined queries. */
const qcols = (t: string) =>
  COLUMNS.split(', ')
    .map((c) => `${t}.${c}`)
    .join(', ')

export const VISIBILITIES: readonly Visibility[] = ['private', 'followers', 'friends', 'public']

/**
 * THE visibility rule, in one place: which visibilities of an owner's audios a
 * given viewer may browse/list. 'private' is owner-only (callers special-case
 * owner === viewer by passing all of VISIBILITIES).
 */
export function allowedVisibilities(
  viewerFollowsOwner: boolean,
  ownerFollowsViewer: boolean,
): Visibility[] {
  const vis: Visibility[] = ['public']
  if (viewerFollowsOwner) vis.push('followers')
  if (viewerFollowsOwner && ownerFollowsViewer) vis.push('friends')
  return vis
}

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
          voice, model, format, client_name, object_key, duration_sec, char_count,
          status, chunks_total, chunks_done, error_message)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
        audio.clientName,
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

  /**
   * Single choke point for "can this user load this audio": their own rows,
   * plus any audio they have SAVED (so saved items play like owned ones).
   */
  async getById(userId: string, id: string): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `select ${COLUMNS} from audios
        where id = $2
          and (user_id = $1
               or exists (select 1 from saved_audios s where s.user_id = $1 and s.audio_id = audios.id))`,
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

  /** Continue Listening: stores the playback position and stamps played_at. False = no such row. */
  async setPosition(userId: string, audioId: string, positionSec: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      'update audios set position_sec = $3, played_at = now() where user_id = $1 and id = $2',
      [userId, audioId, positionSec],
    )
    return (rowCount ?? 0) > 0
  },

  /** Owner-scoped visibility change; returns the updated row or null. */
  async setVisibility(
    userId: string,
    audioId: string,
    visibility: Visibility,
  ): Promise<AudioRecord | null> {
    const { rows } = await pool.query<AudioRow>(
      `update audios set visibility = $3, updated_at = now()
        where user_id = $1 and id = $2 returning ${COLUMNS}`,
      [userId, audioId, visibility],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  /** An owner's ready audios restricted to the given visibilities (browse/profile). */
  async listVisibleByUser(
    ownerId: string,
    visibilities: readonly Visibility[],
    limit = 50,
    offset = 0,
  ): Promise<AudioRecord[]> {
    const { rows } = await pool.query<AudioRow>(
      `select ${COLUMNS} from audios
        where user_id = $1 and status = 'ready' and visibility = any($2)
        order by created_at desc, id desc
        limit $3 offset $4`,
      [ownerId, visibilities, Math.min(Math.max(Math.floor(limit), 1), 200), Math.max(offset, 0)],
    )
    return rows.map(mapRow)
  },

  /** Count of an owner's public ready audios (profile header). */
  async publicCount(ownerId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from audios
        where user_id = $1 and status = 'ready' and visibility = 'public'`,
      [ownerId],
    )
    return rows[0]?.n ?? 0
  },

  /** Explore: recent public ready audios across users with a username, excluding the caller. */
  async listPublicRecent(
    excludeUserId: string,
    limit = 30,
    offset = 0,
  ): Promise<Array<AudioRecord & { ownerUsername: string }>> {
    const { rows } = await pool.query<AudioRow & { owner_username: string }>(
      `select ${qcols('a')}, u.username as owner_username
         from audios a join users u on u.id = a.user_id
        where a.visibility = 'public' and a.status = 'ready'
          and a.user_id <> $1 and u.username is not null
        order by a.created_at desc, a.id desc
        limit $2 offset $3`,
      [excludeUserId, Math.min(Math.max(Math.floor(limit), 1), 200), Math.max(offset, 0)],
    )
    return rows.map((r) => ({ ...mapRow(r), ownerUsername: r.owner_username }))
  },

  /** Fire-and-forget anonymous play counter — aggregate integer only, no per-user rows. */
  async incrementPlays(id: string): Promise<void> {
    await pool.query('update audios set plays = plays + 1 where id = $1', [id])
  },

  /**
   * Explore "follows" shelf: newest ready audios by the caller's followees,
   * restricted per relationship (public + followers always; friends only when
   * mutual — the back-follow left join computes mutuality in one query).
   */
  async listFolloweesRecent(
    userId: string,
    limit = 20,
  ): Promise<Array<AudioRecord & { ownerUsername: string }>> {
    const { rows } = await pool.query<AudioRow & { owner_username: string }>(
      `select ${qcols('a')}, u.username as owner_username
         from follows f
         join audios a on a.user_id = f.followee_id
         join users u on u.id = f.followee_id
         left join follows fb
           on fb.follower_id = f.followee_id and fb.followee_id = f.follower_id
        where f.follower_id = $1
          and a.status = 'ready'
          and u.username is not null
          and (a.visibility in ('public', 'followers')
               or (a.visibility = 'friends' and fb.follower_id is not null))
        order by a.created_at desc, a.id desc
        limit $2`,
      [userId, Math.min(Math.max(Math.floor(limit), 1), 200)],
    )
    return rows.map((r) => ({ ...mapRow(r), ownerUsername: r.owner_username }))
  },

  /** Top public tags (lowercased), only tags carried by at least `min` audios. */
  async topPublicTags(limit = 10, min = 3): Promise<Array<{ tag: string; count: number }>> {
    const { rows } = await pool.query<{ tag: string; count: number }>(
      `select lower(t) as tag, count(distinct a.id)::int as count
         from audios a
         join users u on u.id = a.user_id
        cross join lateral unnest(a.tags) as t
        where a.visibility = 'public' and a.status = 'ready' and u.username is not null
        group by lower(t)
       having count(distinct a.id) >= $2
        order by count(distinct a.id) desc, lower(t)
        limit $1`,
      [limit, min],
    )
    return rows
  },

  /** Public ready audios carrying a tag (exact match, lowercase both sides), newest first. */
  async listByTag(
    tag: string,
    limit = 50,
  ): Promise<Array<AudioRecord & { ownerUsername: string }>> {
    const { rows } = await pool.query<AudioRow & { owner_username: string }>(
      `select ${qcols('a')}, u.username as owner_username
         from audios a join users u on u.id = a.user_id
        where a.visibility = 'public' and a.status = 'ready' and u.username is not null
          and exists (select 1 from unnest(a.tags) t where lower(t) = $1)
        order by a.created_at desc, a.id desc
        limit $2`,
      [tag.toLowerCase(), Math.min(Math.max(Math.floor(limit), 1), 200)],
    )
    return rows.map((r) => ({ ...mapRow(r), ownerUsername: r.owner_username }))
  },

  /** The user's own audios UNION the audios they saved, newest first. */
  async listWithSaved(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ items: AudioRecord[]; total: number }> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200)
    const safeOffset = Math.max(Math.floor(offset), 0)
    const [listResult, countResult] = await Promise.all([
      pool.query<AudioRow>(
        `select ${qcols('a')} from audios a where a.user_id = $1
         union all
         select ${qcols('a')} from saved_audios s join audios a on a.id = s.audio_id
          where s.user_id = $1
         order by created_at desc, id desc
         limit $2 offset $3`,
        [userId, safeLimit, safeOffset],
      ),
      pool.query<{ total: string }>(
        `select ((select count(*) from audios where user_id = $1)
               + (select count(*) from saved_audios where user_id = $1))::text as total`,
        [userId],
      ),
    ])
    return {
      items: listResult.rows.map(mapRow),
      total: Number(countResult.rows[0]?.total ?? 0),
    }
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

export interface UserPrefs {
  voice: string | null
  provider: string | null
  language: string | null
}

export const prefsRepo = {
  async get(userId: string): Promise<UserPrefs> {
    const { rows } = await pool.query<UserPrefs>(
      'select voice, provider, language from user_prefs where user_id = $1',
      [userId],
    )
    return rows[0] ?? { voice: null, provider: null, language: null }
  },

  /** Partial upsert: omitted fields keep their stored value. */
  // ponytail: no way to reset a pref back to null — add a clear path if anyone asks.
  async set(
    userId: string,
    prefs: { voice?: string; provider?: string; language?: string },
  ): Promise<UserPrefs> {
    const { rows } = await pool.query<UserPrefs>(
      `insert into user_prefs (user_id, voice, provider, language, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (user_id)
       do update set voice = coalesce($2, user_prefs.voice),
                     provider = coalesce($3, user_prefs.provider),
                     language = coalesce($4, user_prefs.language),
                     updated_at = now()
       returning voice, provider, language`,
      [userId, prefs.voice ?? null, prefs.provider ?? null, prefs.language ?? null],
    )
    return rows[0]
  },
}

export interface UserProfileRow {
  id: string
  email: string
  username: string | null
  /** Bucket object key of the avatar (Better Auth `image` column), or null. */
  image: string | null
}

// Better Auth owns the `users` table; oto only reads it + manages `username`/`image`.
export const userRepo = {
  async get(userId: string): Promise<UserProfileRow | null> {
    const { rows } = await pool.query<UserProfileRow>(
      'select id, email, username, image from users where id = $1',
      [userId],
    )
    return rows[0] ?? null
  },

  async findByUsername(username: string): Promise<UserProfileRow | null> {
    const { rows } = await pool.query<UserProfileRow>(
      'select id, email, username, image from users where username = $1',
      [username],
    )
    return rows[0] ?? null
  },

  /** Overwrites the username; throws pg 23505 on a collision (caller maps to 409). */
  async setUsername(userId: string, username: string): Promise<void> {
    await pool.query('update users set username = $2 where id = $1', [userId, username])
  },

  /** Stores the avatar's bucket object key in Better Auth's `image` column. */
  async setImage(userId: string, key: string): Promise<void> {
    await pool.query('update users set image = $2 where id = $1', [userId, key])
  },

  /** Username prefix search (people picker). Only users who have a username. */
  async search(
    prefix: string,
    excludeUserId: string,
    limit = 10,
  ): Promise<Array<{ username: string; image: string | null }>> {
    // Strip ilike wildcards so user input can't turn into a pattern.
    const clean = prefix.replace(/[%_\\]/g, '')
    if (!clean) return []
    const { rows } = await pool.query<{ username: string; image: string | null }>(
      `select username, image from users
        where username ilike $1 || '%' and id <> $2 and username is not null
        order by username limit $3`,
      [clean, excludeUserId, limit],
    )
    return rows
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

/**
 * Canonical email for cross-account quota identity: lowercase, +tag stripped;
 * gmail-family addresses also ignore dots. Deleting an account and re-signing
 * up with a trivial variant of the same address must land on the same tombstone.
 */
export function normalizeEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
  let l = local.split('+')[0]
  if (domain === 'gmail.com' || domain === 'googlemail.com') l = l.replaceAll('.', '')
  return `${l}@${domain}`
}

/**
 * Deterministic uuid keying a deleted account's usage tombstone row in
 * usage_counters — account deletion folds generated_sec into it, and a
 * re-signup with the same (normalized) email inherits it, so deleting the
 * account never resets the free-tier quota.
 */
export function usageTombstoneId(email: string): string {
  const h = createHash('sha256').update(`usage-tombstone:${normalizeEmail(email)}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export const usageRepo = {
  /**
   * Cumulative seconds of audio this user has had generated (never decreases),
   * counting: their own counter, the tombstone left by a previously deleted
   * account on the same normalized email (max of the two — addGeneratedSec
   * seeds the own row from the tombstone, so own >= tombstone once seeded),
   * and in-flight 'processing' rows at their length estimate — so parallel
   * requests can't all pass the quota check before any of them finishes.
   * Rows stuck 'processing' past the 15-min janitor window are presumed dead
   * (see resolveStale) and excluded, so a crashed job can't block the quota.
   */
  async generatedSec(userId: string, email?: string): Promise<number> {
    const ids = email ? [userId, usageTombstoneId(email)] : [userId]
    const { rows } = await pool.query<{ total: string }>(
      `select (
          (select coalesce(max(generated_sec), 0) from usage_counters where user_id = any($1::uuid[]))
          -- 15 chars/sec: keep in sync with estimateSec in tts.ts.
        + (select coalesce(sum(char_count), 0) / 15.0 from audios
            where user_id = $2 and status = 'processing'
              and updated_at >= now() - interval '15 minutes')
       )::text as total`,
      [ids, userId],
    )
    const n = Number.parseFloat(rows[0]?.total ?? '0')
    return Number.isFinite(n) ? n : 0
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
    // First write for a user seeds their counter from the tombstone a deleted
    // account left on the same normalized email — delete/re-signup cycles keep
    // accumulating instead of restarting at zero.
    await pool.query(
      `insert into usage_counters (user_id, email, generated_sec, updated_at)
       values ($1, $2, $3 + coalesce((select generated_sec from usage_counters where user_id = $4::uuid), 0), now())
       on conflict (user_id)
       do update set generated_sec = usage_counters.generated_sec + $3,
                     email = coalesce(excluded.email, usage_counters.email),
                     updated_at = now()`,
      [userId, email ?? null, seconds, email ? usageTombstoneId(email) : null],
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

export const followRepo = {
  /** Idempotent. */
  async follow(followerId: string, followeeId: string): Promise<void> {
    await pool.query(
      'insert into follows (follower_id, followee_id) values ($1, $2) on conflict do nothing',
      [followerId, followeeId],
    )
  },

  /** Idempotent. */
  async unfollow(followerId: string, followeeId: string): Promise<void> {
    await pool.query('delete from follows where follower_id = $1 and followee_id = $2', [
      followerId,
      followeeId,
    ])
  },

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    const { rows } = await pool.query(
      'select 1 from follows where follower_id = $1 and followee_id = $2',
      [followerId, followeeId],
    )
    return rows.length > 0
  },

  /** Both directions in one query — feeds allowedVisibilities(). */
  async relation(
    viewerId: string,
    ownerId: string,
  ): Promise<{ viewerFollowsOwner: boolean; ownerFollowsViewer: boolean }> {
    const { rows } = await pool.query<{ vfo: boolean | null; ofv: boolean | null }>(
      `select bool_or(follower_id = $1) as vfo, bool_or(follower_id = $2) as ofv
         from follows
        where (follower_id = $1 and followee_id = $2)
           or (follower_id = $2 and followee_id = $1)`,
      [viewerId, ownerId],
    )
    return {
      viewerFollowsOwner: rows[0]?.vfo ?? false,
      ownerFollowsViewer: rows[0]?.ofv ?? false,
    }
  },

  async isMutual(a: string, b: string): Promise<boolean> {
    const r = await this.relation(a, b)
    return r.viewerFollowsOwner && r.ownerFollowsViewer
  },

  /** Who this user follows (only those with a username), newest follow first. */
  async following(userId: string): Promise<Array<{ username: string; image: string | null }>> {
    const { rows } = await pool.query<{ username: string; image: string | null }>(
      `select u.username, u.image
         from follows f join users u on u.id = f.followee_id
        where f.follower_id = $1 and u.username is not null
        order by f.created_at desc`,
      [userId],
    )
    return rows
  },

  /** Ids of everyone this user follows (recommendation profile input). */
  async followeeIds(userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ followee_id: string }>(
      'select followee_id from follows where follower_id = $1',
      [userId],
    )
    return rows.map((r) => r.followee_id)
  },

  async counts(userId: string): Promise<{ followers: number; following: number }> {
    const { rows } = await pool.query<{ followers: number; following: number }>(
      `select (select count(*) from follows where followee_id = $1)::int as followers,
              (select count(*) from follows where follower_id = $1)::int as following`,
      [userId],
    )
    return rows[0] ?? { followers: 0, following: 0 }
  },
}

export const savedRepo = {
  /** Idempotent; throws FK violation if the audio doesn't exist. */
  async save(userId: string, audioId: string): Promise<void> {
    await pool.query(
      'insert into saved_audios (user_id, audio_id) values ($1, $2) on conflict do nothing',
      [userId, audioId],
    )
  },

  /** Idempotent. */
  async unsave(userId: string, audioId: string): Promise<void> {
    await pool.query('delete from saved_audios where user_id = $1 and audio_id = $2', [
      userId,
      audioId,
    ])
  },

  /** The audios this user saved, newest save first (recommendation profile input). */
  async listSaved(userId: string, limit = 200): Promise<AudioRecord[]> {
    const { rows } = await pool.query<AudioRow>(
      `select ${qcols('a')} from saved_audios s join audios a on a.id = s.audio_id
        where s.user_id = $1
        order by s.created_at desc
        limit $2`,
      [userId, limit],
    )
    return rows.map(mapRow)
  },

  /** Save totals for a set of audios in one grouped query: audio_id -> count. */
  async saveCounts(audioIds: string[]): Promise<Map<string, number>> {
    if (audioIds.length === 0) return new Map()
    const { rows } = await pool.query<{ audio_id: string; n: number }>(
      'select audio_id, count(*)::int as n from saved_audios where audio_id = any($1) group by audio_id',
      [audioIds],
    )
    return new Map(rows.map((r) => [r.audio_id, r.n]))
  },

  async isSaved(userId: string, audioId: string): Promise<boolean> {
    const { rows } = await pool.query(
      'select 1 from saved_audios where user_id = $1 and audio_id = $2',
      [userId, audioId],
    )
    return rows.length > 0
  },
}

export const collectionRepo = {
  async list(
    userId: string,
  ): Promise<Array<{ id: string; name: string; isDefault: boolean; count: number }>> {
    const { rows } = await pool.query<{ id: string; name: string; isDefault: boolean; count: number }>(
      `select c.id, c.name, c.is_default as "isDefault",
              (select count(*) from collection_items ci where ci.collection_id = c.id)::int as count
         from collections c
        where c.user_id = $1
        order by c.is_default desc, c.created_at desc`,
      [userId],
    )
    return rows
  },

  /** Lazily creates the user's default collection; the partial unique index makes this race-safe. */
  async ensureDefault(userId: string): Promise<void> {
    await pool.query(
      `insert into collections (user_id, name, is_default) values ($1, 'Favorites', true)
       on conflict (user_id) where is_default do nothing`,
      [userId],
    )
  },

  async create(userId: string, name: string): Promise<{ id: string; name: string }> {
    const { rows } = await pool.query<{ id: string; name: string }>(
      'insert into collections (user_id, name) values ($1, $2) returning id, name',
      [userId, name],
    )
    return rows[0]
  },

  /** Deletes a non-default collection (items cascade). The default is undeletable. */
  async delete(userId: string, id: string): Promise<'deleted' | 'default' | 'missing'> {
    const { rowCount } = await pool.query(
      'delete from collections where user_id = $1 and id = $2 and not is_default',
      [userId, id],
    )
    if ((rowCount ?? 0) > 0) return 'deleted'
    const { rows } = await pool.query(
      'select 1 from collections where user_id = $1 and id = $2',
      [userId, id],
    )
    return rows.length > 0 ? 'default' : 'missing'
  },

  /** Ownership check for item mutations. */
  async owns(userId: string, id: string): Promise<boolean> {
    const { rows } = await pool.query('select 1 from collections where user_id = $1 and id = $2', [
      userId,
      id,
    ])
    return rows.length > 0
  },

  /** Idempotent; caller must have verified ownership. FK violation if audio is gone. */
  async addItem(collectionId: string, audioId: string): Promise<void> {
    await pool.query(
      'insert into collection_items (collection_id, audio_id) values ($1, $2) on conflict do nothing',
      [collectionId, audioId],
    )
  },

  async removeItem(collectionId: string, audioId: string): Promise<void> {
    await pool.query(
      'delete from collection_items where collection_id = $1 and audio_id = $2',
      [collectionId, audioId],
    )
  },

  /** The collection with its audios, newest-added first. Null if not the caller's. */
  async get(
    userId: string,
    id: string,
  ): Promise<{ id: string; name: string; isDefault: boolean; items: AudioRecord[] } | null> {
    const { rows } = await pool.query<{ id: string; name: string; isDefault: boolean }>(
      'select id, name, is_default as "isDefault" from collections where user_id = $1 and id = $2',
      [userId, id],
    )
    if (!rows[0]) return null
    const items = await pool.query<AudioRow>(
      `select ${qcols('a')} from collection_items ci
         join audios a on a.id = ci.audio_id
        where ci.collection_id = $1
        order by ci.added_at desc`,
      [id],
    )
    return { ...rows[0], items: items.rows.map(mapRow) }
  },
}

// Better Auth's oidcProvider owns the oauth* tables; oto reads them for the
// "AI connections" list and deletes rows to revoke a client (raw SQL, like the
// oauthAccessToken read in auth.ts).
export const connectionRepo = {
  /** Distinct clients this user authorized (consent and/or issued tokens), with the app's registered name. */
  async list(userId: string): Promise<
    Array<{ clientId: string; name: string; firstConnectedAt: string; lastUsedAt: string | null }>
  > {
    const { rows } = await pool.query<{
      client_id: string
      name: string | null
      first_connected_at: Date
      last_used_at: Date | null
    }>(
      `select s.client_id, app.name,
              min(s.created_at) as first_connected_at,
              max(s.used_at) as last_used_at
         from (select "clientId" as client_id, "createdAt" as created_at, null::timestamptz as used_at
                 from "oauthConsent" where "userId" = $1 and "consentGiven"
               union all
               select "clientId", "createdAt", "createdAt"
                 from "oauthAccessToken" where "userId" = $1) s
         left join "oauthApplication" app on app."clientId" = s.client_id
        group by s.client_id, app.name
        order by max(s.used_at) desc nulls last, min(s.created_at) desc`,
      [userId],
    )
    return rows.map((r) => ({
      clientId: r.client_id,
      name: r.name ?? r.client_id,
      firstConnectedAt: r.first_connected_at.toISOString(),
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    }))
  },

  /**
   * Revokes a client for this user: deletes its oauthAccessToken rows (access
   * AND refresh tokens — both live on that table) and its oauthConsent rows.
   */
  async revoke(userId: string, clientId: string): Promise<void> {
    await pool.query('delete from "oauthAccessToken" where "userId" = $1 and "clientId" = $2', [
      userId,
      clientId,
    ])
    await pool.query('delete from "oauthConsent" where "userId" = $1 and "clientId" = $2', [
      userId,
      clientId,
    ])
  },
}

/**
 * Deletes ALL app rows for a user in one transaction and returns the deleted
 * audios' object_key list (caller removes the bucket objects). CONTRACT with
 * better-auth.ts account deletion — do not rename this or drop parameters.
 * Better Auth's own users/sessions/accounts rows are deleted by Better Auth.
 *
 * The usage counter is folded into an email-keyed tombstone row first, so
 * deleting the account and re-signing up never resets the free-tier quota.
 */
export async function deleteUserData(userId: string, email?: string): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const { rows } = await client.query<{ object_key: string }>(
      'delete from audios where user_id = $1 returning object_key',
      [userId],
    )
    await client.query('delete from user_prefs where user_id = $1', [userId])
    if (email) {
      // greatest, not sum: the user's counter already includes any tombstone
      // seed it inherited at signup (see addGeneratedSec), so summing would
      // double-count across delete/re-signup cycles. Only generated_sec
      // carries over — unlimited/Stripe state dies with the account.
      await client.query(
        `insert into usage_counters (user_id, email, generated_sec, updated_at)
         select $2::uuid, $3, generated_sec, now() from usage_counters where user_id = $1
         on conflict (user_id)
         do update set generated_sec = greatest(usage_counters.generated_sec, excluded.generated_sec),
                       updated_at = now()`,
        [userId, usageTombstoneId(email), normalizeEmail(email)],
      )
    }
    await client.query('delete from usage_counters where user_id = $1', [userId])
    await client.query('delete from follows where follower_id = $1 or followee_id = $1', [userId])
    await client.query('delete from saved_audios where user_id = $1', [userId])
    // collection_items cascade; items other users saved from these audios cascade too.
    await client.query('delete from collections where user_id = $1', [userId])
    await client.query('commit')
    return rows.map((r) => r.object_key)
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}
