// Canvas twins of the server-side SVG covers in src/share.ts — both ported
// from specs/cover-lab.html (the canonical design lab), frozen at t=0.
// The PRNG pull ORDER is the cross-platform contract: server SVG, this
// canvas code, and iOS must make the identical pulls in the identical
// order. Do not reorder without updating src/share.ts and iOS.
import { fnv1a, mulberry32 } from './waveform'

const TAU = Math.PI * 2
const pick = <T,>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]

// ── Ink ─────────────────────────────────────────────────────────────────────

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

function inkRings(x: CanvasRenderingContext2D, s: number, rnd: () => number, ink: string): void {
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
  x.save()
  x.beginPath()
  x.arc(cx, cy, rad, 0, TAU)
  x.clip()
  x.strokeStyle = ink
  x.lineWidth = lw
  for (let i = 1; i <= rings; i++) {
    const k = i / rings
    x.beginPath()
    x.arc(cx + Math.cos(dir) * drift * k, cy + Math.sin(dir) * drift * k, gap * i - lw * 0.5, 0, TAU)
    x.stroke()
  }
  x.fillStyle = ink // focal: the solid eye
  x.beginPath()
  x.arc(cx, cy, gap * 0.55, 0, TAU)
  x.fill()
  x.restore()
}

function inkContours(x: CanvasRenderingContext2D, s: number, rnd: () => number, ink: string): void {
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
  x.fillStyle = ink
  for (let k = -2; k < N; k += 2) {
    x.beginPath()
    for (let lvl = 0; lvl < 2; lvl++) {
      const kk = k + lvl
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * TAU
        const r = Math.max(0, rAt(kk, th))
        const px = cx + Math.cos(th) * r
        const py = cy + Math.sin(th) * r
        i ? x.lineTo(px, py) : x.moveTo(px, py)
      }
      x.closePath()
    }
    x.fill('evenodd')
  }
}

function inkBurst(
  x: CanvasRenderingContext2D,
  s: number,
  rnd: () => number,
  paper: string,
  ink: string,
): void {
  const edge = rnd() < 0.45
  const ox = s * (edge ? (rnd() < 0.5 ? 0.08 : 0.92) : 0.5 + (rnd() - 0.5) * 0.14)
  const oy = s * (edge ? 0.5 + (rnd() - 0.5) * 0.6 : 0.5 + (rnd() - 0.5) * 0.14)
  const spokes = 14 + Math.floor(rnd() * 16) * 2
  void rnd() // spin — animation-only, pulled to keep the shared order
  const ph = rnd() * TAU
  const thin = 0.16 + rnd() * 0.16
  x.fillStyle = ink
  for (let i = 0; i < spokes; i++) {
    const a0 = ph + (i / spokes) * TAU
    // NOTE: even spokes pull rnd() INSIDE the loop — part of the contract.
    const w = (TAU / spokes) * (i % 2 ? thin : 0.4 + rnd() * 0.12)
    x.beginPath()
    x.moveTo(ox, oy)
    x.arc(ox, oy, s * 1.6, a0, a0 + w)
    x.closePath()
    x.fill()
  }
  // Focal: paper hub + hairline ring.
  const rr = s * (0.1 + rnd() * 0.07)
  x.fillStyle = paper
  x.beginPath()
  x.arc(ox, oy, rr, 0, TAU)
  x.fill()
  x.strokeStyle = ink
  x.lineWidth = s * 0.012
  x.beginPath()
  x.arc(ox, oy, rr * (1.45 + 0.05 * Math.sin(ph)), 0, TAU)
  x.stroke()
}

function inkHex(x: CanvasRenderingContext2D, s: number, rnd: () => number, ink: string): void {
  const r = s * (0.055 + rnd() * 0.035)
  const lw = r * 0.13 // breathing term is 0 at t=0
  const dx = r * 1.732
  const dy = r * 1.5
  const cols = Math.ceil(s / dx) + 2
  const rows = Math.ceil(s / dy) + 2
  const fx = s * (0.25 + rnd() * 0.5)
  const fy = s * (0.25 + rnd() * 0.5)
  const fr = r * (1.2 + rnd() * 0.9)
  x.strokeStyle = ink
  x.lineWidth = lw
  x.lineJoin = 'round'
  for (let j = -1; j < rows; j++) {
    for (let i = -1; i < cols; i++) {
      const hx = i * dx + (j & 1 ? dx / 2 : 0) // drift is 0 at t=0
      const hy = j * dy
      x.beginPath()
      for (let k = 0; k < 6; k++) {
        const a = (k * TAU) / 6 + Math.PI / 6
        const px = hx + Math.cos(a) * r * 0.94
        const py = hy + Math.sin(a) * r * 0.94
        k ? x.lineTo(px, py) : x.moveTo(px, py)
      }
      x.closePath()
      if (Math.hypot(hx - fx, hy - fy) < fr) {
        x.fillStyle = ink
        x.fill() // focal cluster
      }
      x.stroke()
    }
  }
}

/**
 * Ink cover: one poster-composed pattern on a curated paper stock. The FIRST
 * pull selects the sub-family — floor(rnd()*4) → [rings, contours, burst,
 * hex] — then that family keeps drawing with the same rng.
 */
export function drawInk(x: CanvasRenderingContext2D, id: string, s: number): void {
  const rnd = mulberry32(fnv1a(id))
  const fam = Math.floor(rnd() * 4)
  const st = pick(rnd, INK_STOCK)
  const [paper, ink] = st
  x.fillStyle = paper
  x.fillRect(0, 0, s, s)
  x.save()
  x.beginPath()
  x.rect(s * INK_M, s * INK_M, s * (1 - 2 * INK_M), s * (1 - 2 * INK_M))
  x.clip()
  if (fam === 0) inkRings(x, s, rnd, ink)
  else if (fam === 1) inkContours(x, s, rnd, ink)
  else if (fam === 2) inkBurst(x, s, rnd, paper, ink)
  else inkHex(x, s, rnd, ink)
  x.restore()
}

// ── Halftone ────────────────────────────────────────────────────────────────

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
 * Blob-silhouette density planes — the SAME pure-math code as src/share.ts,
 * so the no-emoji halftone is pixel-for-pixel the server's. The rng here is
 * separate from the cover rng, seeded by the lab's key scheme.
 */
function blobDensity(key: string): Float32Array[] {
  const R = mulberry32(fnv1a(key))
  const cx = HTW * (0.44 + R() * 0.12)
  const cy = HTW * (0.44 + R() * 0.12)
  const rad = HTW * (0.3 + R() * 0.07)
  const h = [R() * TAU, R() * TAU, R() * TAU]
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
          (1 +
            0.24 * Math.sin(3 * th + h[0]) +
            0.13 * Math.sin(5 * th + h[1]) +
            0.08 * Math.sin(7 * th + h[2]))
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
    dens[0][i] = cov[0][i] * (0.3 + 0.8 * (1 - gx))
    dens[1][i] = cov[1][i] * (0.3 + 0.8 * gx)
    dens[2][i] = cov[2][i] * (0.18 + 0.55 * gy)
  }
  return dens
}

/** Emoji silhouette density — the lab's htSource emoji branch (needs canvas). */
function emojiDensity(emoji: string): Float32Array[] {
  const off = document.createElement('canvas')
  off.width = off.height = HTW
  const o = off.getContext('2d', { willReadFrequently: true })!
  o.filter = `blur(${HTW * 0.012}px)` // dot gain
  o.font = `${HTW * 0.84}px "Apple Color Emoji","Segoe UI Emoji",sans-serif`
  o.textAlign = 'center'
  o.textBaseline = 'middle'
  o.fillText(emoji, HTW * 0.5, HTW * 0.53)
  o.filter = 'none'
  const px = o.getImageData(0, 0, HTW, HTW).data
  const dens = [new Float32Array(HTW * HTW), new Float32Array(HTW * HTW), new Float32Array(HTW * HTW)]
  for (let i = 0, p = 0; i < HTW * HTW; i++, p += 4) {
    const al = px[p + 3] / 255
    if (al < 0.01) continue
    // Subtractive separation with grey-component removal — real plates.
    const cy = 1 - px[p] / 255
    const mg = 1 - px[p + 1] / 255
    const yl = 1 - px[p + 2] / 255
    const k = Math.min(cy, mg, yl)
    dens[0][i] = al * Math.min(1, (cy - k) * 1.45 + (yl - k) * 0.22)
    dens[1][i] = al * Math.min(1, (mg - k) * 1.35 + (yl - k) * 0.72)
    dens[2][i] = al * Math.min(0.8, k * 0.78) // key plate stays a shadow
  }
  return dens
}

const densCache = new Map<string, Float32Array[]>()

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
 * Halftone cover. Production contract: emoji present → its silhouette,
 * absent → the blob variant; NEITHER pulls the cover rng (the lab's
 * fixed-emoji path), so the first pull is always the ink-set pick.
 */
export function drawHalftone(
  x: CanvasRenderingContext2D,
  id: string,
  emoji: string | null,
  s: number,
): void {
  const R = mulberry32(fnv1a(id))
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
  const key = `${id}|${useEmoji}${emoji ?? ''}`
  let dens = densCache.get(key)
  if (!dens) {
    dens = useEmoji ? emojiDensity(emoji!) : blobDensity(key)
    densCache.set(key, dens)
  }
  x.fillStyle = set.p
  x.fillRect(0, 0, s, s)
  // t=0 of the lab's breathing transform (brz/dph still shift the pose).
  const zm = zoom * (1 + 0.045 * Math.sin(brz))
  const rt = spin + 0.05 * Math.sin(dph)
  const cr = Math.cos(rt) / zm
  const sr = Math.sin(rt) / zm
  const px0 = shx + 0.012 * Math.sin(dph)
  const py0 = shy + 0.012 * Math.cos(brz)
  const reach = Math.ceil((s * 0.78) / pitch)
  x.globalCompositeOperation = 'multiply'
  for (let k = 0; k < 3; k++) {
    const ca = Math.cos(ang[k])
    const sa = Math.sin(ang[k])
    x.beginPath()
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const gx = i * pitch + reg[k][0]
        const gy = j * pitch + reg[k][1]
        const dx = s * 0.5 + gx * ca - gy * sa
        const dy = s * 0.5 + gx * sa + gy * ca
        if (dx < -pitch || dy < -pitch || dx > s + pitch || dy > s + pitch) continue
        const u = dx / s - 0.5 + px0
        const v = dy / s - 0.5 + py0
        const d = htSample(dens[k], (u * cr - v * sr + 0.5) * HTW, (u * sr + v * cr + 0.5) * HTW)
        if (d < 0.035) continue
        const rr = pitch * 0.63 * Math.sqrt(Math.min(1, d * gain))
        x.moveTo(dx + rr, dy)
        x.arc(dx, dy, rr, 0, TAU)
      }
    }
    x.fillStyle = set.i[k]
    x.globalAlpha = k === 2 ? 0.92 : 0.85
    x.fill()
  }
  x.globalAlpha = 1
  x.globalCompositeOperation = 'source-over'
}
