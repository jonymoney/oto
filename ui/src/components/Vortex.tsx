import { useEffect, useRef } from 'react'
import { OtoMark } from './Mark'

// The instrument dreaming: a rotating logarithmic spiral tunnel rendered as
// ASCII into a single <pre>. Per-cell polar coordinates are precomputed once
// per resize (~80x24 max) and each frame is built as one string, so every
// rAF tick is a single textContent write — no per-cell DOM.
const COLS_MAX = 80
const ROWS_MAX = 24
const COLS_MIN = 24
const ROWS_MIN = 12
const FRAME_MS = 1000 / 30
// When the deck is playing, the twist subtly leans into it.
const PLAYING_SPEED_MULT = 1.45

// Depth ramps, sparse → dense. The seed picks one so each trip reads differently.
const RAMPS = [
  ' .:-=+*#%@',
  ' .,:;!|+*x%#@',
  " .'^:~=+aoXNW@",
]

interface VortexParams {
  dir: 1 | -1
  speed: number
  arms: number
  twist: number
  phase: number
  wobble: number
  ramp: string
}

/** Small deterministic PRNG (mulberry32) so the seed fully shapes the trip. */
function mulberry32(seed: number): () => number {
  let a = Math.floor(seed) || 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function paramsFromSeed(seed: number): VortexParams {
  const rand = mulberry32(seed)
  return {
    dir: rand() < 0.5 ? -1 : 1,
    speed: 0.45 + rand() * 0.75,
    arms: 2 + Math.floor(rand() * 3),
    twist: 2.4 + rand() * 2.2,
    phase: rand() * Math.PI * 2,
    wobble: 0.25 + rand() * 0.45,
    ramp: RAMPS[Math.floor(rand() * RAMPS.length)],
  }
}

interface Grid {
  cols: number
  rows: number
  /** Radius normalized so ~1 reaches the nearest screen edge. */
  radius: Float32Array
  angle: Float32Array
}

function buildGrid(cols: number, rows: number, cellW: number, cellH: number): Grid {
  const radius = new Float32Array(cols * rows)
  const angle = new Float32Array(cols * rows)
  const cx = (cols - 1) / 2
  const cy = (rows - 1) / 2
  const norm = Math.min(cols * cellW, rows * cellH) / 2
  let i = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++, i++) {
      // Work in pixels so character cells (taller than wide) stay circular.
      const dx = (x - cx) * cellW
      const dy = (y - cy) * cellH
      radius[i] = Math.sqrt(dx * dx + dy * dy) / norm
      angle[i] = Math.atan2(dy, dx)
    }
  }
  return { cols, rows, radius, angle }
}

function renderFrame(grid: Grid, p: VortexParams, t: number): string {
  const { cols, rows, radius, angle } = grid
  const last = p.ramp.length - 1
  const spin = p.phase + t * p.speed * p.dir
  const lines: string[] = new Array(rows)
  let i = 0
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++, i++) {
      const r = radius[i]
      // Logarithmic spiral: arms wind tighter toward the core and rotate with t.
      const v =
        angle[i] * p.arms +
        Math.log(r + 0.07) * p.twist -
        spin +
        Math.sin(t * 0.31 + r * 3.1) * p.wobble
      const band = 0.5 + 0.5 * Math.sin(v)
      const depth = Math.max(0, 1 - r * 0.82)
      const lum = band * (0.28 + 0.72 * depth * depth)
      line += p.ramp[Math.min(last, Math.round(lum * last))]
    }
    lines[y] = line
  }
  return lines.join('\n')
}

interface VortexViewProps {
  seed: number
  playing: boolean
  onExit: () => void
}

export function VortexView({ seed, playing, onExit }: VortexViewProps) {
  const crtRef = useRef<HTMLDivElement | null>(null)
  const preRef = useRef<HTMLPreElement | null>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing

  useEffect(() => {
    const crt = crtRef.current
    const pre = preRef.current
    if (!crt || !pre) return

    const params = paramsFromSeed(seed)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    let grid: Grid | null = null
    let raf = 0
    let lastFrame = 0
    let lastNow = performance.now()
    let speedMul = 1
    let t = 0

    const measureCell = (): { w: number; h: number } => {
      const style = getComputedStyle(pre)
      const fontSize = parseFloat(style.fontSize) || 12
      let w = fontSize * 0.62
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx) {
        ctx.font = `${style.fontSize} ${style.fontFamily}`
        const measured = ctx.measureText('M').width
        if (measured > 3 && measured < 30) w = measured
      }
      const h = parseFloat(style.lineHeight) || fontSize
      return { w, h }
    }

    const rebuild = () => {
      const rect = crt.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const { w, h } = measureCell()
      const cols = Math.max(COLS_MIN, Math.min(COLS_MAX, Math.floor(rect.width / w)))
      const rows = Math.max(ROWS_MIN, Math.min(ROWS_MAX, Math.floor(rect.height / h)))
      grid = buildGrid(cols, rows, w, h)
      // Reduced motion: one seed-shaped still frame; CSS handles a gentle breathe.
      if (reduced) pre.textContent = renderFrame(grid, params, 0)
    }

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastFrame < FRAME_MS) return
      lastFrame = now
      const dt = Math.min((now - lastNow) / 1000, 0.25)
      lastNow = now
      // Ease the twist speed toward the playback state — visualizer companion.
      speedMul += ((playingRef.current ? PLAYING_SPEED_MULT : 1) - speedMul) * 0.04
      t += dt * speedMul
      if (grid) pre.textContent = renderFrame(grid, params, t)
    }

    rebuild()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(rebuild) : null
    ro?.observe(crt)
    if (!reduced) raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [seed])

  return (
    <section className="oto-panel oto-vortex" aria-label="oto vortex">
      <header className="oto-bar">
        <OtoMark ledOn={playing} />
        <span className="oto-bar-spacer" />
        <span className="oto-count">vortex</span>
        <button type="button" className="oto-ghost" onClick={onExit} aria-label="Exit vortex">
          eject
        </button>
      </header>
      <div ref={crtRef} className="oto-vortex-crt">
        <pre ref={preRef} className="oto-vortex-screen" aria-hidden="true" />
        <div className="oto-vortex-scan" aria-hidden="true" />
      </div>
    </section>
  )
}
