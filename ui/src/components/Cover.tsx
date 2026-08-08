import { useEffect, useRef } from 'react'
import { fnv1a, mulberry32 } from '../waveform'

// Shared "mesh" cover spec — the iOS app draws the identical pattern so the
// same audio id + mood always yields the same art on both platforms. Do not
// change the palette, blob count, or PRNG draw order without updating iOS.
const MOODS: Record<string, [string, string, string]> = {
  calm: ['#1d9e75', '#0f6e56', '#378add'],
  energetic: ['#f5a623', '#d85a30', '#ef9f27'],
  serious: ['#534ab7', '#185fa5', '#3c3489'],
  playful: ['#d4537e', '#7f77dd', '#ed93b1'],
  warm: ['#d85a30', '#f5a623', '#993c1d'],
}
const FALLBACK_ORDER = ['warm', 'calm', 'energetic', 'serious', 'playful'] as const

function palette(id: string, mood: string | null): [string, string, string] {
  const key = mood ?? ''
  return MOODS[key] ?? MOODS[FALLBACK_ORDER[fnv1a(id) % 5]]
}

// Backing store scale — spec renders at 2×; the math stays in W units so the
// pattern is identical to iOS regardless of pixel density.
const SCALE = 2

function drawMesh(canvas: HTMLCanvasElement, id: string, mood: string | null, W: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  canvas.width = W * SCALE
  canvas.height = W * SCALE
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)

  const pal = palette(id, mood)
  const rnd = mulberry32(fnv1a(id))

  ctx.fillStyle = pal[2]
  ctx.fillRect(0, 0, W, W)

  for (let i = 0; i < 7; i++) {
    // PRNG draw order is exactly x, y, r — must match iOS.
    const x = rnd() * W
    const y = rnd() * W
    const r = W * (0.35 + rnd() * 0.5)
    const color = pal[i % 3]
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, color)
    g.addColorStop(1, color + '00')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, W)
  }
}

interface CoverProps {
  /** Audio id — seeds the deterministic pattern. */
  id: string
  /** One-word mood tinting the palette (null → deterministic fallback). */
  mood: string | null
  /** Rendered side length in CSS px. */
  size: number
  /** Optional emoji badge overlaid on the art. */
  emoji?: string | null
  className?: string
}

export function Cover({ id, mood, size, emoji, className }: CoverProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (canvasRef.current) drawMesh(canvasRef.current, id, mood, size)
  }, [id, mood, size])

  return (
    <div
      className={className ? `oto-cover ${className}` : 'oto-cover'}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="oto-cover-canvas" />
      {emoji && (
        <span className="oto-cover-emoji" style={{ fontSize: Math.round(size * 0.34) }}>
          {emoji}
        </span>
      )}
    </div>
  )
}
