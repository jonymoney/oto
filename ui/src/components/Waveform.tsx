import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { barHeights } from '../waveform'
import { formatTimecode } from '../format'

const BAR_COUNT = 48
const KEY_STEP_SECONDS = 5

interface WaveformProps {
  /** Audio id — seeds the deterministic bar pattern so it's stable per track. */
  seedId: string
  position: number
  duration: number | null
  playing: boolean
  busy: boolean
  onSeek: (seconds: number) => void
}

export function Waveform({ seedId, position, duration, playing, busy, onSeek }: WaveformProps) {
  const heights = useMemo(() => barHeights(seedId, BAR_COUNT), [seedId])
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const [dragFrac, setDragFrac] = useState<number | null>(null)

  const dur = duration ?? 0
  const seekable = dur > 0
  const frac = dragFrac ?? (seekable ? Math.min(position / dur, 1) : 0)
  const litCount = Math.round(frac * BAR_COUNT)

  const fracAt = (event: PointerEvent<HTMLDivElement>): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!seekable) return
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragFrac(fracAt(event))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    setDragFrac(fracAt(event))
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const f = fracAt(event)
    setDragFrac(null)
    if (seekable) onSeek(f * dur)
  }
  const onPointerCancel = () => {
    draggingRef.current = false
    setDragFrac(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!seekable) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const delta = event.key === 'ArrowLeft' ? -KEY_STEP_SECONDS : KEY_STEP_SECONDS
      onSeek(Math.min(Math.max(position + delta, 0), dur))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onSeek(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      onSeek(dur)
    }
  }

  return (
    <div
      ref={trackRef}
      className="oto-wave"
      data-playing={playing}
      data-busy={busy}
      data-disabled={!seekable}
      role="slider"
      tabIndex={seekable ? 0 : -1}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur)}
      aria-valuenow={Math.round(frac * dur)}
      aria-valuetext={`${formatTimecode(frac * dur)} of ${formatTimecode(duration)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className={i < litCount ? 'oto-wave-bar lit' : 'oto-wave-bar'}
          style={{
            height: `${Math.round(h * 100)}%`,
            animationDelay: `${-((i * 137) % 1400)}ms`,
          }}
        />
      ))}
    </div>
  )
}
