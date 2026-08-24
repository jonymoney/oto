import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import { Resvg } from '@resvg/resvg-js'
import { audioRepo, userRepo } from './db.js'
import { presignAudioUrl, presignAvatarUrl } from './storage.js'
import { config } from './config.js'
import { coerceCoverStyle } from './types.js'
import type { AudioRecord, CoverStyle } from './types.js'

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
  // Ids are referenced document-wide once inlined — suffix so covers on the
  // same page (profile thumbs) can't resolve to each other's gradients.
  const uid = fnv1a(id).toString(36)
  let defs = ''
  let rects = ''
  for (let i = 0; i < 7; i++) {
    // PRNG draw order is exactly x, y, r — must match web/iOS.
    const x = rnd() * W
    const y = rnd() * W
    const r = W * (0.35 + rnd() * 0.5)
    const c = pal[i % 3]
    defs += `<radialGradient id="g${uid}${i}" gradientUnits="userSpaceOnUse" cx="${x}" cy="${y}" r="${r}"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`
    rects += `<rect width="${w}" height="${h}" fill="url(#g${uid}${i})"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${pal[2]}"/>${defs}${rects}</svg>`
}

// ── Ink + halftone covers (server-side SVG twins of ui/src/covers.ts) ───────
// Ported from specs/cover-lab.html (the canonical design lab), frozen at t=0.
// The PRNG pull ORDER is the cross-platform contract — web canvas and iOS
// must make the identical pulls in the identical order. Do not reorder.

const TAU = Math.PI * 2
const pick = <T,>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]
/** Trim coordinates to 2 decimals — keeps inline SVG payloads sane. */
const f2 = (n: number) => Math.round(n * 100) / 100

// Curated ink/stock constants — verbatim from the lab. Do not edit.
const INK_STOCK: ReadonlyArray<readonly [string, string, string]> = [
  ['#F1EBDC', '#15130F', 'shikkoku on cream'],
  ['#F4F7EE', '#181A13', 'shikkoku on byakuroku'],
  ['#FAFCF5', '#1E50A2', 'ruri on gofun'],
  ['#F2EDDF', '#9E3D3F', 'suo on cream'],
  ['#F4F7EE', '#5C7D1E', 'moegi on byakuroku'],
  ['#F1EBDC', '#004C71', 'ai on cream'],
  ['#FFFFFF', '#595857', 'sumi on shironeri'],
  ['#F2EDDF', '#D3381C', 'hi on cream'],
]
const INK_M = 0.065 // one poster margin for every ink family

function inkRings(rnd: () => number, s: number, ink: string, uid: string): string {
  const crop = rnd() < 0.38
  const cx = s * (crop ? (rnd() < 0.5 ? 0.16 : 0.84) : 0.5 + (rnd() - 0.5) * 0.18)
  const cy = s * (crop ? 0.5 + (rnd() - 0.5) * 0.5 : 0.5 + (rnd() - 0.5) * 0.18)
  const rad = s * (crop ? 0.72 + rnd() * 0.22 : 0.4 + rnd() * 0.05)
  const rings = 9 + Math.floor(rnd() * 9)
  const gap = rad / rings
  const lw = gap * (0.34 + rnd() * 0.16)
  const dir = rnd() * TAU
  void rnd() // spin — animation-only, pulled to keep the shared order
  const drift = gap * (0.9 + rnd() * 0.7)
  let out = `<clipPath id="r${uid}"><circle cx="${f2(cx)}" cy="${f2(cy)}" r="${f2(rad)}"/></clipPath><g clip-path="url(#r${uid})">`
  for (let i = 1; i <= rings; i++) {
    const k = i / rings
    out += `<circle cx="${f2(cx + Math.cos(dir) * drift * k)}" cy="${f2(cy + Math.sin(dir) * drift * k)}" r="${f2(gap * i - lw * 0.5)}" fill="none" stroke="${ink}" stroke-width="${f2(lw)}"/>`
  }
  // Focal: the solid eye.
  out += `<circle cx="${f2(cx)}" cy="${f2(cy)}" r="${f2(gap * 0.55)}" fill="${ink}"/></g>`
  return out
}

function inkContours(rnd: () => number, s: number, ink: string): string {
  const cx = s * (0.42 + rnd() * 0.16)
  const cy = s * (0.42 + rnd() * 0.16)
  const base = s * (0.1 + rnd() * 0.06)
  const h = [
    { n: 2 + Math.floor(rnd() * 2), a: 0.3 + rnd() * 0.16, p: rnd() * TAU, w: 0.17 + rnd() * 0.12 },
    { n: 4 + Math.floor(rnd() * 2), a: 0.16 + rnd() * 0.1, p: rnd() * TAU, w: -0.13 - rnd() * 0.12 },
    { n: 7 + Math.floor(rnd() * 3), a: 0.07 + rnd() * 0.05, p: rnd() * TAU, w: 0.09 + rnd() * 0.1 },
  ]
  const sp = s * (0.03 + rnd() * 0.016) * (1 + 0.07 * Math.sin(h[0].p))
  void (rnd() < 0.5) // slide — animation-only, pulled to keep the shared order
  const N = Math.ceil((s * 0.95) / sp) + 3
  const SEG = 96
  const rAt = (k: number, th: number) => {
    const fall = 1 / (1 + Math.abs(k) * 0.13)
    let r = base + k * sp
    for (const q of h) r += base * q.a * fall * Math.sin(q.n * th + q.p)
    return r
  }
  let out = ''
  for (let k = -2; k < N; k += 2) {
    let d = ''
    for (let lvl = 0; lvl < 2; lvl++) {
      const kk = k + lvl
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * TAU
        const r = Math.max(0, rAt(kk, th))
        d += `${i ? 'L' : 'M'}${f2(cx + Math.cos(th) * r)} ${f2(cy + Math.sin(th) * r)}`
      }
      d += 'Z'
    }
    out += `<path d="${d}" fill="${ink}" fill-rule="evenodd"/>`
  }
  return out
}

function inkBurst(rnd: () => number, s: number, paper: string, ink: string): string {
  const edge = rnd() < 0.45
  const ox = s * (edge ? (rnd() < 0.5 ? 0.08 : 0.92) : 0.5 + (rnd() - 0.5) * 0.14)
  const oy = s * (edge ? 0.5 + (rnd() - 0.5) * 0.6 : 0.5 + (rnd() - 0.5) * 0.14)
  const spokes = 14 + Math.floor(rnd() * 16) * 2
  void rnd() // spin — animation-only, pulled to keep the shared order
  const ph = rnd() * TAU
  const thin = 0.16 + rnd() * 0.16
  const R = s * 1.6
  let out = ''
  for (let i = 0; i < spokes; i++) {
    const a0 = ph + (i / spokes) * TAU
    // NOTE: even spokes pull rnd() INSIDE the loop — part of the contract.
    const w = (TAU / spokes) * (i % 2 ? thin : 0.4 + rnd() * 0.12)
    const x1 = ox + Math.cos(a0) * R
    const y1 = oy + Math.sin(a0) * R
    const x2 = ox + Math.cos(a0 + w) * R
    const y2 = oy + Math.sin(a0 + w) * R
    out += `<path d="M${f2(ox)} ${f2(oy)}L${f2(x1)} ${f2(y1)}A${f2(R)} ${f2(R)} 0 0 1 ${f2(x2)} ${f2(y2)}Z" fill="${ink}"/>`
  }
  // Focal: paper hub + hairline ring.
  const rr = s * (0.1 + rnd() * 0.07)
  out += `<circle cx="${f2(ox)}" cy="${f2(oy)}" r="${f2(rr)}" fill="${paper}"/>`
  out += `<circle cx="${f2(ox)}" cy="${f2(oy)}" r="${f2(rr * (1.45 + 0.05 * Math.sin(ph)))}" fill="none" stroke="${ink}" stroke-width="${f2(s * 0.012)}"/>`
  return out
}

function inkHex(rnd: () => number, s: number, ink: string): string {
  const r = s * (0.055 + rnd() * 0.035)
  const lw = r * 0.13 // breathing term is 0 at t=0
  const dx = r * 1.732
  const dy = r * 1.5
  const cols = Math.ceil(s / dx) + 2
  const rows = Math.ceil(s / dy) + 2
  const fx = s * (0.25 + rnd() * 0.5)
  const fy = s * (0.25 + rnd() * 0.5)
  const fr = r * (1.2 + rnd() * 0.9)
  let out = ''
  for (let j = -1; j < rows; j++) {
    for (let i = -1; i < cols; i++) {
      const hx = i * dx + (j & 1 ? dx / 2 : 0) // drift is 0 at t=0
      const hy = j * dy
      let pts = ''
      for (let k = 0; k < 6; k++) {
        const a = (k * TAU) / 6 + Math.PI / 6
        pts += `${k ? ' ' : ''}${f2(hx + Math.cos(a) * r * 0.94)},${f2(hy + Math.sin(a) * r * 0.94)}`
      }
      const focal = Math.hypot(hx - fx, hy - fy) < fr
      out += `<polygon points="${pts}" fill="${focal ? ink : 'none'}" stroke="${ink}" stroke-width="${f2(lw)}" stroke-linejoin="round"/>`
    }
  }
  return out
}

/**
 * Ink cover: one poster-composed pattern on a curated paper stock. The FIRST
 * pull selects the sub-family — floor(rnd()*4) → [rings, contours, burst,
 * hex] — then that family keeps drawing with the same rng.
 */
function inkSvg(id: string, w: number, h: number): string {
  const rnd = mulberry32(fnv1a(id))
  const s = Math.max(w, h)
  const uid = fnv1a(id).toString(36)
  const fam = Math.floor(rnd() * 4)
  const [paper, ink] = pick(rnd, INK_STOCK)
  const m = s * INK_M
  const body =
    fam === 0
      ? inkRings(rnd, s, ink, uid)
      : fam === 1
        ? inkContours(rnd, s, ink)
        : fam === 2
          ? inkBurst(rnd, s, paper, ink)
          : inkHex(rnd, s, ink)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="${paper}"/>` +
    `<clipPath id="m${uid}"><rect x="${f2(m)}" y="${f2(m)}" width="${f2(s - 2 * m)}" height="${f2(s - 2 * m)}"/></clipPath>` +
    `<g clip-path="url(#m${uid})">${body}</g></svg>`
  )
}

// ── Halftone cover ──────────────────────────────────────────────────────────

const HTW = 168
// Curated ink sets — verbatim from the lab (oto brand voice colours + stock).
const HT_INKS: ReadonlyArray<{ n: string; i: [string, string, string]; p: string }> = [
  { n: 'asagi/shu', i: ['#00A3AF', '#EB6101', '#181A13'], p: '#FAFCF5' },
  { n: 'ruri/kurenai', i: ['#1E50A2', '#C22645', '#12141C'], p: '#F2EDDF' },
  { n: 'moegi/sumi', i: ['#7BA428', '#595857', '#181A13'], p: '#F4F7EE' },
  { n: 'kikyo/tsutsuji', i: ['#5654A2', '#E95295', '#1A1620'], p: '#FFFFFF' },
  { n: 'tokiwa/kohaku', i: ['#007B43', '#BF783A', '#14140F'], p: '#F1EBDC' },
  { n: 'konpeki/yamabuki', i: ['#007BBB', '#F8B500', '#101418'], p: '#FAFCF5' },
  { n: 'sumi/shu', i: ['#595857', '#EB6101', '#181A13'], p: '#F4F7EE' },
  { n: 'seiji/akane', i: ['#819C8B', '#B7282E', '#171310'], p: '#F0EADB' },
]

/** Separable box blur (radius 2), run 3× ≈ the lab's canvas blur(HTW*.03). */
function boxBlur(buf: Float32Array): void {
  const r = 2
  const w = HTW
  const tmp = new Float32Array(buf.length)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const xx = x + k
        if (xx >= 0 && xx < w) {
          sum += buf[y * w + xx]
          n++
        }
      }
      tmp[y * w + x] = sum / n
    }
  }
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy >= 0 && yy < w) {
          sum += tmp[yy * w + x]
          n++
        }
      }
      buf[y * w + x] = sum / n
    }
  }
}

/**
 * Three-plate density buffers for the harmonic-blob silhouette — a pure-math
 * twin of the lab's canvas htSource (blob branch). The rng here is SEPARATE
 * from the cover rng, seeded by the same key scheme the lab uses.
 * ponytail: the lab's gaussian blur + antialiasing become a 3-pass box blur
 * on binary coverage — dot layouts match the canvas within a hair.
 */
function blobDensity(key: string): Float32Array[] {
  const R = mulberry32(fnv1a(key))
  const cx = HTW * (0.44 + R() * 0.12)
  const cy = HTW * (0.44 + R() * 0.12)
  const rad = HTW * (0.3 + R() * 0.07)
  const h = [R() * TAU, R() * TAU, R() * TAU]
  // Plates: R → ink1, G → ink2, B → shadow, each the same shape nudged.
  const plates: ReadonlyArray<[number, number, number]> = [
    [-rad * 0.045, -rad * 0.03, 1],
    [rad * 0.05, rad * 0.035, 0.96],
    [rad * 0.14, rad * 0.13, 0.62],
  ]
  const cov = plates.map(([pdx, pdy, k]) => {
    const buf = new Float32Array(HTW * HTW)
    for (let y = 0; y < HTW; y++) {
      for (let x = 0; x < HTW; x++) {
        const px = x + 0.5 - cx - pdx
        const py = y + 0.5 - cy - pdy
        const th = Math.atan2(py, px)
        const rr =
          rad *
          k *
          (1 + 0.24 * Math.sin(3 * th + h[0]) + 0.13 * Math.sin(5 * th + h[1]) + 0.08 * Math.sin(7 * th + h[2]))
        if (px * px + py * py <= rr * rr) buf[y * HTW + x] = 1
      }
    }
    boxBlur(buf)
    boxBlur(buf)
    boxBlur(buf)
    return buf
  })
  const dens = [new Float32Array(HTW * HTW), new Float32Array(HTW * HTW), new Float32Array(HTW * HTW)]
  for (let i = 0; i < HTW * HTW; i++) {
    // The lab reads back un-premultiplied pixels, so its al·(cov/al) cancels:
    // each plate is just its own coverage times the gradient weight (this is
    // also what iOS computes — see Cover.swift blobDensity).
    const gx = (i % HTW) / HTW
    const gy = ((i / HTW) | 0) / HTW
    // Plates weighted in opposite directions — a two-ink gradient, not mud.
    dens[0][i] = cov[0][i] * (0.3 + 0.8 * (1 - gx))
    dens[1][i] = cov[1][i] * (0.3 + 0.8 * gx)
    dens[2][i] = cov[2][i] * (0.18 + 0.55 * gy)
  }
  return dens
}

function htSample(buf: Float32Array, bx: number, by: number): number {
  if (bx < 0 || by < 0 || bx > HTW - 1.01 || by > HTW - 1.01) return 0
  const ix = bx | 0
  const iy = by | 0
  const fx = bx - ix
  const fy = by - iy
  const o = iy * HTW + ix
  return (
    buf[o] * (1 - fx) * (1 - fy) +
    buf[o + 1] * fx * (1 - fy) +
    buf[o + HTW] * (1 - fx) * fy +
    buf[o + HTW + 1] * fx * fy
  )
}

/**
 * Halftone cover as plain circles (resvg-safe). Production contract: emoji
 * present → useEmoji=true, absent → blob variant; NEITHER pulls the rng (the
 * lab's fixed-emoji path), so the first pull is always the ink-set pick.
 * ponytail: the server has no emoji rasterizer, so the silhouette here is
 * always the blob-density twin — canvas/iOS renderers substitute the real
 * emoji density buffer for the same lattice when the audio has an emoji.
 */
function halftoneSvg(id: string, emoji: string | null, w: number, h: number): string {
  const R = mulberry32(fnv1a(id))
  const s = Math.max(w, h)
  const useEmoji = !!emoji
  // The five collision-avoidance channels — order is the contract.
  const set = pick(R, HT_INKS) /* 1. ink + stock */
  const pitch = s / (14 + Math.floor(R() * 18)) /* 2. coarse..fine */
  const zoom = 0.72 + R() * 1.25 /* 3. scale (>1 crops) */
  const spin = (R() - 0.5) * 0.9 /*    rotation */
  const shx = (R() - 0.5) * 0.3
  const shy = (R() - 0.5) * 0.3 /*    crop offset */
  const aoff = (R() * Math.PI) / 2 /* 4. screen angle */
  const mis = 0.06 + R() * 0.5 /* 5. misregistration */
  const ang = [15, 75, 45].map((d) => (d * Math.PI) / 180 + aoff)
  const reg = [0, 1, 2].map(() => [(R() - 0.5) * pitch * mis, (R() - 0.5) * pitch * mis])
  const gain = 0.95 + R() * 0.3
  const brz = R() * TAU
  const dph = R() * TAU
  // Same key scheme as the lab: id + '|' + useEmoji + emoji.
  const dens = blobDensity(`${id}|${useEmoji}${emoji ?? ''}`)
  // t=0 of the lab's breathing transform (brz/dph still shift the pose).
  const zm = zoom * (1 + 0.045 * Math.sin(brz))
  const rt = spin + 0.05 * Math.sin(dph)
  const cr = Math.cos(rt) / zm
  const sr = Math.sin(rt) / zm
  const px0 = shx + 0.012 * Math.sin(dph)
  const py0 = shy + 0.012 * Math.cos(brz)
  const reach = Math.ceil((s * 0.78) / pitch)
  let plates = ''
  for (let k = 0; k < 3; k++) {
    const ca = Math.cos(ang[k])
    const sa = Math.sin(ang[k])
    let dots = ''
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const gx = i * pitch + reg[k][0]
        const gy = j * pitch + reg[k][1]
        const dx = s * 0.5 + gx * ca - gy * sa
        const dy = s * 0.5 + gx * sa + gy * ca
        // Lab culls to the s-square; also cull below w×h — pure output trim.
        if (dx < -pitch || dy < -pitch || dx > w + pitch || dy > h + pitch) continue
        const u = dx / s - 0.5 + px0
        const v = dy / s - 0.5 + py0
        const d = htSample(dens[k], (u * cr - v * sr + 0.5) * HTW, (u * sr + v * cr + 0.5) * HTW)
        if (d < 0.035) continue
        const rr = pitch * 0.63 * Math.sqrt(Math.min(1, d * gain))
        dots += `<circle cx="${f2(dx)}" cy="${f2(dy)}" r="${f2(rr)}"/>`
      }
    }
    plates += `<g fill="${set.i[k]}" fill-opacity="${k === 2 ? 0.92 : 0.85}" style="mix-blend-mode:multiply">${dots}</g>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="${set.p}"/>${plates}</svg>`
  )
}

// Style dispatch — new styles register here (open/closed), never as if-chains.
const COVER_RENDERERS: Record<
  CoverStyle,
  (id: string, mood: string | null, emoji: string | null, w: number, h: number) => string
> = {
  classic: (id, mood, _emoji, w, h) => meshSvg(id, mood, w, h),
  ink: (id, _mood, _emoji, w, h) => inkSvg(id, w, h),
  halftone: (id, _mood, emoji, w, h) => halftoneSvg(id, emoji, w, h),
}

/** The audio's cover in its creator's chosen style, ground only (no type). */
export function coverSvg(
  style: CoverStyle,
  id: string,
  mood: string | null,
  emoji: string | null,
  w: number,
  h: number,
): string {
  return COVER_RENDERERS[style](id, mood, emoji, w, h)
}

/** Dark grounds get a scrim + light type; ink/halftone paper gets a veil + ink type. */
const isDarkGround = (style: CoverStyle) => style === 'classic'

// ── Short links: oto.audio/{username}/{slug} ────────────────────────────────

// Existing top-level routes — never assignable as usernames.
export const RESERVED_USERNAMES = new Set([
  'api', 'mcp', 'a', 'login', 'oauth', 'consent', 'upgrade', 'health', 'auth',
  'billing', 'icon.png', 'favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known',
  'well-known', 'apple-app-site-association', 'img', 'voices',
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
  coverStyle: CoverStyle,
): string {
  const title = esc(rec.title)
  const name = esc(username)
  const desc = esc(`${rec.summary ?? 'Listen on oto'} · by @${username}`)
  const coverUrl = `${shareUrlFor(username, slug)}/cover.png`
  const chips = rec.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')
  const bars = '<i></i>'.repeat(5)
  const meta = [esc(rec.voice), fmtDur(rec.durationSec)]
  if (rec.clientName) meta.push(`made with ${esc(rec.clientName)}`)
  // Editorial type over the ground (per the lab's editorialType): lowercase
  // title, every third word in serif italic, mono strap of real metadata.
  const tone = isDarkGround(coverStyle) ? 'dark' : 'light'
  const strap = esc(
    ['oto', rec.mood, fmtDur(rec.durationSec), rec.language]
      .filter((p): p is string => !!p)
      .join(' · ')
      .toUpperCase(),
  )
  const typeTitle = rec.title
    .toLowerCase()
    .replace(/:/g, '')
    .split(' ')
    .map((w, i) => (i % 3 === 1 ? `<em>${esc(w)}</em>` : esc(w)))
    .join(' ')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — oto</title>${appBannerMeta(shareUrlFor(username, slug))}
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${coverUrl}">
<meta property="og:type" content="music.song">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@1,600&family=Jost:wght@600&display=swap" rel="stylesheet">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F7EE;color:#181A13;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}
main{padding:2rem 1.5rem;max-width:26rem;width:100%;box-sizing:border-box}
.brand{font-size:.95rem;letter-spacing:.04em;margin-bottom:1.4rem}.led{color:#7BA428}
.cover{position:relative;width:min(16rem,70vw);margin:0 auto;border-radius:14px;overflow:hidden;
box-shadow:0 10px 30px rgba(22,19,15,.18)}
.cover svg{display:block;width:100%;height:auto}
.cover .veil{position:absolute;inset:0}
.cover .veil.dark{background:linear-gradient(rgba(8,7,5,.62),rgba(8,7,5,.30) 55%,rgba(8,7,5,.66))}
.cover .veil.light{background:linear-gradient(rgba(244,247,238,.86),rgba(244,247,238,.60) 60%,rgba(244,247,238,.06))}
.cover .type{position:absolute;inset:9%;overflow:hidden;text-align:left}
.cover.dark .type{color:#fff}
.cover.light .type{color:#181A13}
.cover .strap{font-size:.62rem;letter-spacing:.08em;opacity:.78;font-weight:500}
.cover.light .strap{opacity:.62}
.cover .ct{margin-top:1.1em;font-family:Jost,system-ui,sans-serif;font-weight:600;
font-size:1.5rem;line-height:1.14;overflow-wrap:anywhere}
.cover .ct em{font-family:Fraunces,Georgia,serif;font-style:italic}
h1{font-size:1.15rem;line-height:1.4;margin:1.2rem 0 .3rem;overflow-wrap:anywhere}
.back{position:fixed;top:1rem;left:1.1rem;color:#6D7561;text-decoration:none;font-size:.8rem}
.back:hover{color:#7BA428}
.byline{display:inline-flex;align-items:center;gap:.45rem;color:#7BA428;font-weight:700;
font-size:.95rem;text-decoration:none;margin:0 0 .35rem}
.byline:hover{text-decoration:underline}
.byline .ava{width:1.5rem;height:1.5rem;border-radius:50%;object-fit:cover;flex:none}
.byline .ini{display:grid;place-items:center;color:#FAFCF5;font-size:.7rem;font-weight:700}
.meta{color:#6D7561;font-size:.8rem;margin:0 0 .8rem}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;justify-content:center;margin-bottom:1.4rem}
.chip{background:#E7EBDD;color:#6D7561;border-radius:99px;padding:.2rem .65rem;font-size:.72rem}
.player{display:flex;align-items:center;gap:.8rem;background:#FAFCF5;border:1px solid #DDE3D1;
border-radius:14px;padding:.8rem .9rem;text-align:left}
#pp{flex:none;width:2.9rem;height:2.9rem;border-radius:50%;border:none;background:#7BA428;color:#181A13;
font-size:1rem;cursor:pointer;display:grid;place-items:center}
.track{flex:1;min-width:0}
.bar{height:6px;background:#E7EBDD;border-radius:3px;cursor:pointer;position:relative}
#fill{height:100%;width:0;background:#7BA428;border-radius:3px}
.times{display:flex;justify-content:space-between;color:#6D7561;font-size:.72rem;margin-top:.35rem}
.viz{flex:none;display:flex;align-items:flex-end;gap:2px;height:1.4rem}
.viz i{width:3px;background:#7BA428;border-radius:2px;height:30%;animation:eq 1s ease-in-out infinite;
animation-play-state:paused}
.viz i:nth-child(2){animation-delay:.15s}.viz i:nth-child(3){animation-delay:.3s}
.viz i:nth-child(4){animation-delay:.45s}.viz i:nth-child(5){animation-delay:.6s}
.playing .viz i{animation-play-state:running}
@keyframes eq{0%,100%{height:25%}50%{height:100%}}
footer{margin-top:1.6rem;font-size:.8rem;color:#6D7561}
footer a{color:#181A13;text-decoration:none;font-weight:700}footer a:hover{color:#7BA428}
</style></head><body>
<a class="back" href="/${name}">← @${name}</a>
<main>
<div class="brand"><span class="led">◉</span> oto</div>
<div class="cover ${tone}">${coverSvg(coverStyle, rec.id, rec.mood, rec.emoji, 320, 320)}<div class="veil ${tone}"></div>
<div class="type"><div class="strap">${strap}</div><div class="ct">${typeTitle}${rec.emoji ? ` ${esc(rec.emoji)}` : ''}</div></div></div>
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
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F7EE;color:#181A13;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}main{padding:2rem;max-width:26rem}
h1{font-size:1.2rem}.led{color:#7BA428}p{color:#6D7561;line-height:1.6;font-size:.9rem}
a{color:#181A13;font-weight:700;text-decoration:none}a:hover{color:#7BA428}</style>
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

// ── Universal links: apple-app-site-association ─────────────────────────────
// Team GF73A5V3YY / bundle audio.oto.app. Profile + share pages open the iOS
// app when installed; every reserved top-level path stays in the browser.
const AASA = {
  applinks: {
    details: [
      {
        appIDs: ['GF73A5V3YY.audio.oto.app'],
        components: [
          { '/': '/', exclude: true },
          ...[...RESERVED_USERNAMES].flatMap((p) => [
            { '/': `/${p}`, exclude: true },
            { '/': `/${p}/*`, exclude: true },
          ]),
          { '/': '/*' },
        ],
      },
    ],
  },
}

/** Smart App Banner — inert until APP_STORE_ID is set (post App Store launch). */
function appBannerMeta(pageUrl: string): string {
  if (!config.APP_STORE_ID) return ''
  return `\n<meta name="apple-itunes-app" content="app-id=${config.APP_STORE_ID}, app-argument=${pageUrl}">`
}

export function shareRouter(): Router {
  const router = Router()

  // Apple fetches the .well-known path first, then falls back to the root.
  // Must be JSON served directly — no redirects.
  for (const p of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    router.get(p, (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.json(AASA)
    })
  }

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
      // Anonymous aggregate play counter — fire-and-forget, never blocks the redirect.
      void audioRepo.incrementPlays(rec.id).catch(() => {})
      res.setHeader('Cache-Control', 'no-store')
      res.redirect(302, await presignAudioUrl(rec.objectKey))
    }),
  )

  // og:image — the cover rasterized in the creator's style. Deterministic per
  // id + owner style, so cacheable.
  router.get(
    '/a/:id/cover.png',
    wrap(async (req, res) => {
      const rec = await readyAudio(req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      const style = coerceCoverStyle((await userRepo.get(rec.userId))?.coverStyle)
      // ponytail: og image stays type-free (ground only) — link previews show
      // the title as text, and resvg has no font/emoji rendering here anyway.
      const png = new Resvg(coverSvg(style, rec.id, rec.mood, rec.emoji, 1200, 630))
        .render()
        .asPng()
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
  coverStyle: CoverStyle,
): string {
  const name = esc(username)
  const avatar = avatarHtml(username, avatarUrl)
  const list = rows
    .map(
      // Thumb size tier: ground + emoji badge only, no type.
      ({ rec, slug }) => `<a class="row" href="${esc(shareUrlFor(username, slug))}">
<span class="thumb">${coverSvg(coverStyle, rec.id, rec.mood, rec.emoji, 44, 44)}${rec.emoji ? `<span class="e">${esc(rec.emoji)}</span>` : ''}</span>
<span class="info"><span class="t">${esc(rec.title)}</span><span class="m">${esc(rec.voice)} · ${fmtDur(rec.durationSec)}</span></span>
</a>`,
    )
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${name} — oto</title>${appBannerMeta(new URL(`/${username}`, config.BETTER_AUTH_URL).href)}
<meta property="og:title" content="@${name} — oto">
<meta property="og:type" content="profile">
<link rel="icon" type="image/png" href="/icon.png">
<style>
body{margin:0;min-height:100vh;background:#F4F7EE;color:#181A13;
font-family:ui-monospace,'SF Mono',Menlo,monospace}
main{padding:2rem 1.5rem;max-width:26rem;margin:0 auto;box-sizing:border-box}
.brand{font-size:.95rem;letter-spacing:.04em;margin-bottom:1.4rem;text-align:center}.led{color:#7BA428}
header{display:flex;align-items:center;gap:1rem;margin-bottom:1.4rem}
.ava{width:4rem;height:4rem;border-radius:50%;object-fit:cover;flex:none;
box-shadow:0 4px 14px rgba(22,19,15,.15)}
.ini{display:grid;place-items:center;color:#FAFCF5;font-size:1.6rem;font-weight:700}
h1{font-size:1.15rem;margin:0;overflow-wrap:anywhere}
.count{color:#6D7561;font-size:.8rem;margin-top:.25rem}
.row{display:flex;align-items:center;gap:.8rem;background:#FAFCF5;border:1px solid #DDE3D1;
border-radius:14px;padding:.65rem .8rem;margin-bottom:.6rem;text-decoration:none;color:#181A13}
.row:hover{border-color:#7BA428}
.thumb{position:relative;flex:none;width:44px;height:44px;border-radius:10px;overflow:hidden}
.thumb svg{display:block}
.thumb .e{position:absolute;inset:0;display:grid;place-items:center;font-size:1.2rem;
text-shadow:0 1px 6px rgba(0,0,0,.25)}
.info{min-width:0}
.t{display:block;font-size:.9rem;line-height:1.35;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
.m{display:block;color:#6D7561;font-size:.72rem;margin-top:.15rem}
footer{margin-top:1.6rem;font-size:.8rem;color:#6D7561;text-align:center}
footer a{color:#181A13;text-decoration:none;font-weight:700}footer a:hover{color:#7BA428}
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
      res.type('html').send(
        profilePage(user.username!, avatarUrl, rows, coerceCoverStyle(user.coverStyle)),
      )
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
      res.type('html').send(
        sharePage(
          rec,
          req.params.username,
          req.params.slug,
          avatarUrl,
          coerceCoverStyle(user?.coverStyle),
        ),
      )
    }),
  )

  router.get(
    '/:username/:slug/audio',
    wrap(async (req, res) => {
      const rec = await readyBySlug(req.params.username, req.params.slug)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      // Anonymous aggregate play counter — fire-and-forget, never blocks the redirect.
      void audioRepo.incrementPlays(rec.id).catch(() => {})
      res.setHeader('Cache-Control', 'no-store')
      res.redirect(302, await presignAudioUrl(rec.objectKey))
    }),
  )

  router.get(
    '/:username/:slug/cover.png',
    wrap(async (req, res) => {
      const rec = await readyBySlug(req.params.username, req.params.slug)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      const user = await userRepo.findByUsername(req.params.username)
      const style = coerceCoverStyle(user?.coverStyle)
      const png = new Resvg(coverSvg(style, rec.id, rec.mood, rec.emoji, 1200, 630))
        .render()
        .asPng()
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.type('png').send(Buffer.from(png))
    }),
  )

  return router
}
