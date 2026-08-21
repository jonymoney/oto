import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import { Resvg } from '@resvg/resvg-js'
import { audioRepo, userRepo } from './db.js'
import { presignAudioUrl, presignAvatarUrl } from './storage.js'
import { config } from './config.js'
import type { AudioRecord } from './types.js'

// Public Spotify-style share pages. NO auth: the audio id is an unguessable
// UUID, so the link itself is the capability — mounted in src/index.ts before
// the auth middlewares alongside the other public routes.

// ── Mesh cover (server-side twin of ui/src/components/Cover.tsx) ────────────
// Same palette, PRNG, blob count, and draw order as the web + iOS covers.
// Do not change without updating ui/src/components/Cover.tsx and iOS.
const MOODS: Record<string, [string, string, string]> = {
  calm: ['#1d9e75', '#0f6e56', '#378add'],
  energetic: ['#f5a623', '#d85a30', '#ef9f27'],
  serious: ['#534ab7', '#185fa5', '#3c3489'],
  playful: ['#d4537e', '#7f77dd', '#ed93b1'],
  warm: ['#d85a30', '#f5a623', '#993c1d'],
}
const FALLBACK_ORDER = ['warm', 'calm', 'energetic', 'serious', 'playful'] as const

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function palette(id: string, mood: string | null): [string, string, string] {
  return MOODS[mood ?? ''] ?? MOODS[FALLBACK_ORDER[fnv1a(id) % 5]]
}

/**
 * The mesh pattern as SVG. Blob math runs on W = max(w, h) so a non-square
 * canvas (the 1200x630 og image) is the square pattern cropped, not stretched.
 */
function meshSvg(id: string, mood: string | null, w: number, h: number): string {
  const pal = palette(id, mood)
  const rnd = mulberry32(fnv1a(id))
  const W = Math.max(w, h)
  let defs = ''
  let rects = ''
  for (let i = 0; i < 7; i++) {
    // PRNG draw order is exactly x, y, r — must match web/iOS.
    const x = rnd() * W
    const y = rnd() * W
    const r = W * (0.35 + rnd() * 0.5)
    const c = pal[i % 3]
    defs += `<radialGradient id="g${i}" gradientUnits="userSpaceOnUse" cx="${x}" cy="${y}" r="${r}"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`
    rects += `<rect width="${w}" height="${h}" fill="url(#g${i})"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${pal[2]}"/>${defs}${rects}</svg>`
}

// ── Short links: oto.audio/{username}/{slug} ────────────────────────────────

// Existing top-level routes — never assignable as usernames.
export const RESERVED_USERNAMES = new Set([
  'api', 'mcp', 'a', 'login', 'oauth', 'consent', 'upgrade', 'health', 'auth',
  'billing', 'icon.png', 'favicon.ico', 'robots.txt', '.well-known', 'well-known',
  'terms', 'privacy', 'connect', 'explore', 'me', 'users', 'collections', 'avatars',
])

const rand = (n: number) => randomBytes(n).toString('hex').slice(0, n)

const kebab = (s: string, max: number) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

/** Canonical public share URL — the ONE place the short form is built. */
export function shareUrlFor(username: string, slug: string): string {
  return new URL(`/${username}/${slug}`, config.BETTER_AUTH_URL).href
}

/** The user's username, deriving + storing it from their email on first use. */
export async function usernameFor(userId: string): Promise<string> {
  const user = await userRepo.get(userId)
  if (!user) throw new Error(`No user ${userId}`)
  if (user.username) return user.username
  const base = kebab(user.email.split('@')[0] ?? '', 24)
  let name = !base || RESERVED_USERNAMES.has(base) ? `user-${rand(6)}` : base
  for (let tries = 0; tries < 5; tries++) {
    try {
      if (await userRepo.claimUsername(userId, name)) return name
      // Lost a concurrent claim on our own row — use whatever won.
      const claimed = (await userRepo.get(userId))?.username
      if (claimed) return claimed
    } catch {
      // Unique collision with another user — retry with a random suffix.
    }
    name = `${(base || 'user').slice(0, 19)}-${rand(4)}`
  }
  throw new Error(`Could not assign a username for user ${userId}`)
}

/** The audio's slug, generating + storing it from the title on first use. */
export async function ensureSlug(rec: AudioRecord): Promise<string> {
  if (rec.slug) return rec.slug
  const base = kebab(rec.title, 40) || 'audio'
  let slug = base
  for (let n = 2; await audioRepo.slugTaken(rec.userId, slug); n++) {
    slug = `${base.slice(0, 37)}-${n}`
  }
  try {
    await audioRepo.setSlug(rec.id, slug)
  } catch {
    // ponytail: lost a rare check-then-set race — random suffix, no retry loop.
    slug = `${base.slice(0, 34)}-${rand(4)}`
    await audioRepo.setSlug(rec.id, slug)
  }
  rec.slug = slug
  return slug
}

// ── Share page ──────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function fmtDur(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '–:––'
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Avatar image, or an initials circle tinted deterministically from the username. */
function avatarHtml(username: string, avatarUrl: string | null): string {
  if (avatarUrl) return `<img class="ava" src="${esc(avatarUrl)}" alt="">`
  const tint = palette(username, null)
  return `<div class="ava ini" style="background:${tint[0]}">${esc(username[0]?.toUpperCase() ?? '?')}</div>`
}

function sharePage(
  rec: AudioRecord,
  username: string,
  slug: string,
  avatarUrl: string | null,
): string {
  const title = esc(rec.title)
  const name = esc(username)
  const desc = esc(`${rec.summary ?? 'Listen on oto'} · by @${username}`)
  const coverUrl = `${shareUrlFor(username, slug)}/cover.png`
  const chips = rec.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')
  const bars = '<i></i>'.repeat(5)
  const meta = [esc(rec.voice), fmtDur(rec.durationSec)]
  if (rec.clientName) meta.push(`made with ${esc(rec.clientName)}`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — oto</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${coverUrl}">
<meta property="og:type" content="music.song">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/icon.png">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#16130f;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}
main{padding:2rem 1.5rem;max-width:26rem;width:100%;box-sizing:border-box}
.brand{font-size:.95rem;letter-spacing:.04em;margin-bottom:1.4rem}.led{color:#f5a623}
.cover{position:relative;width:min(16rem,70vw);margin:0 auto;border-radius:14px;overflow:hidden;
box-shadow:0 10px 30px rgba(22,19,15,.18)}
.cover svg{display:block;width:100%;height:auto}
.cover .emoji{position:absolute;inset:0;display:grid;place-items:center;font-size:4rem;
text-shadow:0 2px 12px rgba(0,0,0,.25)}
h1{font-size:1.15rem;line-height:1.4;margin:1.2rem 0 .3rem;overflow-wrap:anywhere}
.back{position:fixed;top:1rem;left:1.1rem;color:#6f6555;text-decoration:none;font-size:.8rem}
.back:hover{color:#f5a623}
.byline{display:inline-flex;align-items:center;gap:.45rem;color:#f5a623;font-weight:700;
font-size:.95rem;text-decoration:none;margin:0 0 .35rem}
.byline:hover{text-decoration:underline}
.byline .ava{width:1.5rem;height:1.5rem;border-radius:50%;object-fit:cover;flex:none}
.byline .ini{display:grid;place-items:center;color:#fffdf8;font-size:.7rem;font-weight:700}
.meta{color:#6f6555;font-size:.8rem;margin:0 0 .8rem}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;justify-content:center;margin-bottom:1.4rem}
.chip{background:#e8e2d5;color:#6f6555;border-radius:99px;padding:.2rem .65rem;font-size:.72rem}
.player{display:flex;align-items:center;gap:.8rem;background:#fffdf8;border:1px solid #e3dccc;
border-radius:14px;padding:.8rem .9rem;text-align:left}
#pp{flex:none;width:2.9rem;height:2.9rem;border-radius:50%;border:none;background:#f5a623;color:#16130f;
font-size:1rem;cursor:pointer;display:grid;place-items:center}
.track{flex:1;min-width:0}
.bar{height:6px;background:#e8e2d5;border-radius:3px;cursor:pointer;position:relative}
#fill{height:100%;width:0;background:#f5a623;border-radius:3px}
.times{display:flex;justify-content:space-between;color:#6f6555;font-size:.72rem;margin-top:.35rem}
.viz{flex:none;display:flex;align-items:flex-end;gap:2px;height:1.4rem}
.viz i{width:3px;background:#f5a623;border-radius:2px;height:30%;animation:eq 1s ease-in-out infinite;
animation-play-state:paused}
.viz i:nth-child(2){animation-delay:.15s}.viz i:nth-child(3){animation-delay:.3s}
.viz i:nth-child(4){animation-delay:.45s}.viz i:nth-child(5){animation-delay:.6s}
.playing .viz i{animation-play-state:running}
@keyframes eq{0%,100%{height:25%}50%{height:100%}}
footer{margin-top:1.6rem;font-size:.8rem;color:#6f6555}
footer a{color:#16130f;text-decoration:none;font-weight:700}footer a:hover{color:#f5a623}
</style></head><body>
<a class="back" href="/${name}">← @${name}</a>
<main>
<div class="brand"><span class="led">◉</span> oto</div>
<div class="cover">${meshSvg(rec.id, rec.mood, 320, 320)}${rec.emoji ? `<span class="emoji">${esc(rec.emoji)}</span>` : ''}</div>
<h1>${title}</h1>
<a class="byline" href="/${name}">${avatarHtml(username, avatarUrl)}<span>@${name}</span></a>
<p class="meta">${meta.join(' · ')}</p>
${chips ? `<div class="chips">${chips}</div>` : ''}
<div class="player" id="player">
  <button id="pp" aria-label="Play">▶</button>
  <div class="track">
    <div class="bar" id="bar"><div id="fill"></div></div>
    <div class="times"><span id="cur">0:00</span><span id="tot">${fmtDur(rec.durationSec)}</span></div>
  </div>
  <div class="viz" aria-hidden="true">${bars}</div>
</div>
<audio id="au" src="/${username}/${slug}/audio" preload="metadata"></audio>
<footer>Made with <a href="/">◉ oto</a></footer>
</main><script>
const au = document.getElementById('au'), pp = document.getElementById('pp'),
  fill = document.getElementById('fill'), bar = document.getElementById('bar'),
  cur = document.getElementById('cur'), tot = document.getElementById('tot'),
  player = document.getElementById('player');
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const dur = () => (isFinite(au.duration) && au.duration) || ${rec.durationSec ?? 0} || 0;
pp.onclick = () => au.paused ? au.play() : au.pause();
au.onplay = () => { pp.textContent = '❚❚'; pp.setAttribute('aria-label', 'Pause'); player.classList.add('playing'); };
au.onpause = () => { pp.textContent = '▶'; pp.setAttribute('aria-label', 'Play'); player.classList.remove('playing'); };
au.onended = au.onpause;
au.ontimeupdate = () => {
  const d = dur();
  fill.style.width = d ? (au.currentTime / d * 100) + '%' : '0';
  cur.textContent = fmt(au.currentTime);
};
au.onloadedmetadata = () => { if (isFinite(au.duration)) tot.textContent = fmt(au.duration); };
bar.onclick = e => {
  const d = dur();
  if (d) au.currentTime = (e.clientX - bar.getBoundingClientRect().left) / bar.offsetWidth * d;
};
</script></body></html>`
}

const notFoundPage = (
  message = "This audio doesn't exist, or isn't ready yet.",
) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — oto</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#16130f;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}main{padding:2rem;max-width:26rem}
h1{font-size:1.2rem}.led{color:#f5a623}p{color:#6f6555;line-height:1.6;font-size:.9rem}
a{color:#16130f;font-weight:700;text-decoration:none}a:hover{color:#f5a623}</style>
</head><body><main><h1><span class="led">◉</span> oto</h1>
<p>${esc(message)}</p><p><a href="/">Made with ◉ oto</a></p>
</main></body></html>`

// Express 4 swallows async throws — wrap so rejections hit the error handler.
const wrap =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The audio iff it exists and is playable — pg throws on non-uuid ids, so pre-check. */
async function readyAudio(id: string): Promise<AudioRecord | null> {
  if (!UUID_RE.test(id)) return null
  const rec = await audioRepo.getByIdPublic(id)
  return rec && rec.status === 'ready' ? rec : null
}

export function shareRouter(): Router {
  const router = Router()

  // Legacy long links: 301 to the canonical short URL (lazily assigns
  // username + slug on first hit). /a/:id/audio and cover keep serving direct.
  router.get(
    '/a/:id',
    wrap(async (req, res) => {
      const rec = await readyAudio(req.params.id)
      if (!rec) return res.status(404).type('html').send(notFoundPage())
      const url = shareUrlFor(await usernameFor(rec.userId), await ensureSlug(rec))
      res.redirect(301, url)
    }),
  )

  // Fresh presigned URL per hit — the <audio> src and any direct link both work.
  router.get(
    '/a/:id/audio',
    wrap(async (req, res) => {
      const rec = await readyAudio(req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      res.setHeader('Cache-Control', 'no-store')
      res.redirect(302, await presignAudioUrl(rec.objectKey))
    }),
  )

  // og:image — the mesh cover rasterized. Deterministic per id, so cacheable.
  router.get(
    '/a/:id/cover.png',
    wrap(async (req, res) => {
      const rec = await readyAudio(req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      // ponytail: emoji/title omitted from the og image — pure mesh; resvg has
      // no emoji font here anyway. Add text via satori/font embed if wanted.
      const png = new Resvg(meshSvg(rec.id, rec.mood, 1200, 630)).render().asPng()
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.type('png').send(Buffer.from(png))
    }),
  )

  return router
}

// ── Short-link routes (/:username/:slug) ────────────────────────────────────
// A catch-all — mounted LAST in src/index.ts so it never shadows real routes.

async function readyBySlug(username: string, slug: string): Promise<AudioRecord | null> {
  const userId = await userRepo.findIdByUsername(username)
  if (!userId) return null
  const rec = await audioRepo.getBySlugPublic(userId, slug)
  return rec && rec.status === 'ready' ? rec : null
}

// ── Public profile page (/:username) ────────────────────────────────────────

function profilePage(
  username: string,
  avatarUrl: string | null,
  rows: Array<{ rec: AudioRecord; slug: string }>,
): string {
  const name = esc(username)
  const avatar = avatarHtml(username, avatarUrl)
  const list = rows
    .map(
      ({ rec, slug }) => `<a class="row" href="${esc(shareUrlFor(username, slug))}">
<span class="thumb">${meshSvg(rec.id, rec.mood, 44, 44)}${rec.emoji ? `<span class="e">${esc(rec.emoji)}</span>` : ''}</span>
<span class="info"><span class="t">${esc(rec.title)}</span><span class="m">${esc(rec.voice)} · ${fmtDur(rec.durationSec)}</span></span>
</a>`,
    )
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${name} — oto</title>
<meta property="og:title" content="@${name} — oto">
<meta property="og:type" content="profile">
<link rel="icon" type="image/png" href="/icon.png">
<style>
body{margin:0;min-height:100vh;background:#f4f1ea;color:#16130f;
font-family:ui-monospace,'SF Mono',Menlo,monospace}
main{padding:2rem 1.5rem;max-width:26rem;margin:0 auto;box-sizing:border-box}
.brand{font-size:.95rem;letter-spacing:.04em;margin-bottom:1.4rem;text-align:center}.led{color:#f5a623}
header{display:flex;align-items:center;gap:1rem;margin-bottom:1.4rem}
.ava{width:4rem;height:4rem;border-radius:50%;object-fit:cover;flex:none;
box-shadow:0 4px 14px rgba(22,19,15,.15)}
.ini{display:grid;place-items:center;color:#fffdf8;font-size:1.6rem;font-weight:700}
h1{font-size:1.15rem;margin:0;overflow-wrap:anywhere}
.count{color:#6f6555;font-size:.8rem;margin-top:.25rem}
.row{display:flex;align-items:center;gap:.8rem;background:#fffdf8;border:1px solid #e3dccc;
border-radius:14px;padding:.65rem .8rem;margin-bottom:.6rem;text-decoration:none;color:#16130f}
.row:hover{border-color:#f5a623}
.thumb{position:relative;flex:none;width:44px;height:44px;border-radius:10px;overflow:hidden}
.thumb svg{display:block}
.thumb .e{position:absolute;inset:0;display:grid;place-items:center;font-size:1.2rem;
text-shadow:0 1px 6px rgba(0,0,0,.25)}
.info{min-width:0}
.t{display:block;font-size:.9rem;line-height:1.35;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
.m{display:block;color:#6f6555;font-size:.72rem;margin-top:.15rem}
footer{margin-top:1.6rem;font-size:.8rem;color:#6f6555;text-align:center}
footer a{color:#16130f;text-decoration:none;font-weight:700}footer a:hover{color:#f5a623}
</style></head><body><main>
<div class="brand"><span class="led">◉</span> oto</div>
<header>${avatar}<div><h1>@${name}</h1><div class="count">${rows.length} audio${rows.length === 1 ? '' : 's'}</div></div></header>
${list}
<footer>Made with <a href="/">◉ oto</a></footer>
</main></body></html>`
}

export function shortShareRouter(): Router {
  const router = Router()

  // Public profile: a user's PUBLIC ready audios. Reserved paths never reach
  // here (mounted last in src/index.ts).
  router.get(
    '/:username',
    wrap(async (req, res) => {
      const user = await userRepo.findByUsername(req.params.username)
      const recs = user ? await audioRepo.listVisibleByUser(user.id, ['public'], 50, 0) : []
      if (!user || recs.length === 0) {
        return res.status(404).type('html').send(notFoundPage('Nothing public here (yet).'))
      }
      // Sequential ensureSlug — same-title rows must not race each other.
      const rows = []
      for (const rec of recs) rows.push({ rec, slug: await ensureSlug(rec) })
      const avatarUrl = user.image ? await presignAvatarUrl(user.image) : null
      res.setHeader('Cache-Control', 'no-store')
      res.type('html').send(profilePage(user.username!, avatarUrl, rows))
    }),
  )

  router.get(
    '/:username/:slug',
    wrap(async (req, res) => {
      const rec = await readyBySlug(req.params.username, req.params.slug)
      if (!rec) return res.status(404).type('html').send(notFoundPage())
      const user = await userRepo.findByUsername(req.params.username)
      const avatarUrl = user?.image ? await presignAvatarUrl(user.image) : null
      res.setHeader('Cache-Control', 'no-store')
      res.type('html').send(sharePage(rec, req.params.username, req.params.slug, avatarUrl))
    }),
  )

  router.get(
    '/:username/:slug/audio',
    wrap(async (req, res) => {
      const rec = await readyBySlug(req.params.username, req.params.slug)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      res.setHeader('Cache-Control', 'no-store')
      res.redirect(302, await presignAudioUrl(rec.objectKey))
    }),
  )

  router.get(
    '/:username/:slug/cover.png',
    wrap(async (req, res) => {
      const rec = await readyBySlug(req.params.username, req.params.slug)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      const png = new Resvg(meshSvg(rec.id, rec.mood, 1200, 630)).render().asPng()
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.type('png').send(Buffer.from(png))
    }),
  )

  return router
}
