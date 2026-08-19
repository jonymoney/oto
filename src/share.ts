import { Router } from 'express'
import type { RequestHandler } from 'express'
import { Resvg } from '@resvg/resvg-js'
import { audioRepo } from './db.js'
import { presignAudioUrl } from './storage.js'
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

// ── Share page ──────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function fmtDur(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '–:––'
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function sharePage(rec: AudioRecord): string {
  const title = esc(rec.title)
  const desc = esc(rec.summary ?? 'Listen on oto')
  const coverUrl = new URL(`/a/${rec.id}/cover.png`, config.BETTER_AUTH_URL).href
  const chips = rec.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')
  const bars = '<i></i>'.repeat(5)
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
.meta{color:#6f6555;font-size:.85rem;margin:0 0 .8rem}
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
</style></head><body><main>
<div class="brand"><span class="led">◉</span> oto</div>
<div class="cover">${meshSvg(rec.id, rec.mood, 320, 320)}${rec.emoji ? `<span class="emoji">${esc(rec.emoji)}</span>` : ''}</div>
<h1>${title}</h1>
<p class="meta">${esc(rec.voice)} · ${fmtDur(rec.durationSec)}</p>
${chips ? `<div class="chips">${chips}</div>` : ''}
<div class="player" id="player">
  <button id="pp" aria-label="Play">▶</button>
  <div class="track">
    <div class="bar" id="bar"><div id="fill"></div></div>
    <div class="times"><span id="cur">0:00</span><span id="tot">${fmtDur(rec.durationSec)}</span></div>
  </div>
  <div class="viz" aria-hidden="true">${bars}</div>
</div>
<audio id="au" src="/a/${rec.id}/audio" preload="metadata"></audio>
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

const notFoundPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — oto</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#16130f;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}main{padding:2rem;max-width:26rem}
h1{font-size:1.2rem}.led{color:#f5a623}p{color:#6f6555;line-height:1.6;font-size:.9rem}
a{color:#16130f;font-weight:700;text-decoration:none}a:hover{color:#f5a623}</style>
</head><body><main><h1><span class="led">◉</span> oto</h1>
<p>This audio doesn't exist, or isn't ready yet.</p><p><a href="/">Made with ◉ oto</a></p>
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

  router.get(
    '/a/:id',
    wrap(async (req, res) => {
      const rec = await readyAudio(req.params.id)
      if (!rec) return res.status(404).type('html').send(notFoundPage)
      res.setHeader('Cache-Control', 'no-store')
      res.type('html').send(sharePage(rec))
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
