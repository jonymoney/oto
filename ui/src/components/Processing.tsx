import { useEffect, useRef } from 'react'
import { OtoMark } from './Mark'

// The instrument rendering: a strip of block glyphs undulating like a live
// waveform while background chunks land. Same animation discipline as the
// vortex — geometry rebuilt on resize, one rAF loop, and each frame is three
// textContent writes (lit / render head / unrendered), no per-bar DOM state.
const GLYPHS = '▁▂▃▄▅▆▇█'
const BARS_MIN = 32
const BARS_MAX = 48
const FRAME_MS = 1000 / 26
// Rough speech rate behind the "~4.2 min audio" caption estimate.
const CHARS_PER_SEC = 15

/** A background generation the widget is tracking. */
export interface ProcessingJob {
  id: string
  title: string
  charCount: number
  chunksDone: number
  chunksTotal: number
  /** Terminal failure reported by the server — the row is dead. */
  error: string | null
  /** Polling gave up after consecutive transport failures (retryable). */
  stalled: boolean
}

/** Small deterministic PRNG (mulberry32) — the audio id shapes the wave. */
function mulberry32(seed: number): () => number {
  let a = Math.floor(seed) || 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function estimateLabel(charCount: number): string {
  const sec = charCount / CHARS_PER_SEC
  if (sec < 60) return `~${Math.max(1, Math.round(sec))}s audio`
  return `~${(sec / 60).toFixed(1)} min audio`
}

interface ProcessingViewProps {
  job: ProcessingJob
  onHistory: () => void
  onClose: () => void
  onVortex: () => void
  /** Delete the dead row after a terminal error. */
  onDiscard: () => void
  /** Resume polling after it gave up. */
  onRetryPoll: () => void
}

export function ProcessingView({
  job,
  onHistory,
  onClose,
  onVortex,
  onDiscard,
  onRetryPoll,
}: ProcessingViewProps) {
  const waveRef = useRef<HTMLDivElement | null>(null)
  const litRef = useRef<HTMLSpanElement | null>(null)
  const headRef = useRef<HTMLSpanElement | null>(null)
  const restRef = useRef<HTMLSpanElement | null>(null)
  const redrawRef = useRef<(() => void) | null>(null)

  const frac = job.chunksTotal > 0 ? Math.min(job.chunksDone / job.chunksTotal, 1) : 0
  const fracRef = useRef(frac)
  fracRef.current = frac
  const dead = Boolean(job.error || job.stalled)

  useEffect(() => {
    const wave = waveRef.current
    const lit = litRef.current
    const head = headRef.current
    const rest = restRef.current
    if (!wave || !lit || !head || !rest) return

    const rand = mulberry32(fnv1a(job.id))
    const phase1 = rand() * Math.PI * 2
    const phase2 = rand() * Math.PI * 2
    // Per-bar character, stable for this job across resizes (first `bars` used).
    const noise = Float32Array.from({ length: BARS_MAX }, () => rand())
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const animate = !reduced && !dead

    let bars = 0
    let raf = 0
    let lastFrame = 0
    let lastT = 0
    const t0 = performance.now()

    const cellWidth = (): number => {
      const style = getComputedStyle(wave)
      const fontSize = parseFloat(style.fontSize) || 13
      let w = fontSize * 0.62
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx) {
        ctx.font = `${style.fontSize} ${style.fontFamily}`
        const measured = ctx.measureText('█').width
        if (measured > 3 && measured < 30) w = measured
      }
      return w + (parseFloat(style.letterSpacing) || 0)
    }

    const draw = (t: number) => {
      if (!bars) return
      lastT = t
      let glyphs = ''
      for (let i = 0; i < bars; i++) {
        // Traveling wave + slower counter-swell, weighted per bar; the frozen
        // modes (reduced motion, dead row) hold calm mid-height bars instead.
        const a = animate
          ? 0.1 +
            0.9 *
              (0.5 +
                0.5 *
                  (0.62 * Math.sin(i * 0.42 - t * 2.6 + phase1) +
                    0.38 * Math.sin(i * 0.155 + t * 1.15 + phase2))) *
              (0.45 + 0.55 * noise[i])
          : 0.38 + 0.24 * noise[i]
        glyphs += GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(a * GLYPHS.length))]
      }
      const headIdx = Math.min(bars - 1, Math.floor(fracRef.current * bars))
      lit.textContent = glyphs.slice(0, headIdx)
      head.textContent = glyphs[headIdx]
      rest.textContent = glyphs.slice(headIdx + 1)
    }

    const rebuild = () => {
      const width = wave.getBoundingClientRect().width
      if (width <= 0) return
      bars = Math.max(BARS_MIN, Math.min(BARS_MAX, Math.floor(width / cellWidth())))
      draw(lastT)
    }

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastFrame < FRAME_MS) return
      lastFrame = now
      draw((now - t0) / 1000)
    }

    redrawRef.current = () => draw(lastT)
    rebuild()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(rebuild) : null
    ro?.observe(wave)
    if (animate) raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      redrawRef.current = null
    }
  }, [job.id, dead])

  // Without the rAF loop (reduced motion / frozen wave) the amber fill still
  // has to track chunk progress.
  useEffect(() => {
    redrawRef.current?.()
  }, [frac])

  return (
    <section className="oto-panel" aria-label="oto rendering">
      <header className="oto-bar">
        <OtoMark ledOn={!dead} onSecret={onVortex} />
        <span className="oto-bar-spacer" />
        <span className="oto-count">
          {job.error
            ? 'failed'
            : job.stalled
              ? 'stalled'
              : job.chunksTotal > 0
                ? `${Math.round(frac * 100)}%`
                : '···'}
        </span>
        <button type="button" className="oto-ghost" onClick={onHistory}>
          history
        </button>
        <button type="button" className="oto-ghost oto-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <h1 className="oto-title" title={job.title}>
        {job.title}
      </h1>

      <div
        className="oto-render-screen"
        data-dead={dead}
        role="progressbar"
        aria-label="Rendering audio"
        aria-valuemin={0}
        aria-valuemax={job.chunksTotal > 0 ? job.chunksTotal : undefined}
        aria-valuenow={job.chunksTotal > 0 ? job.chunksDone : undefined}
      >
        <div ref={waveRef} className="oto-render-wave" aria-hidden="true">
          <span ref={litRef} className="oto-render-lit" />
          <span ref={headRef} className="oto-render-head" />
          <span ref={restRef} className="oto-render-rest" />
        </div>
      </div>

      <p className="oto-render-caption">
        rendering
        {job.chunksTotal > 0 && ` · chunk ${job.chunksDone}/${job.chunksTotal}`} ·{' '}
        {estimateLabel(job.charCount)}
      </p>

      {job.error ? (
        <div className="oto-error" role="alert">
          <span>{job.error}</span>
          <button type="button" className="oto-ghost" onClick={onDiscard}>
            discard
          </button>
        </div>
      ) : job.stalled ? (
        <div className="oto-error" role="alert">
          <span>Lost contact while rendering</span>
          <button type="button" className="oto-ghost" onClick={onRetryPoll}>
            retry
          </button>
        </div>
      ) : null}
    </section>
  )
}
