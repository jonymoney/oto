import { useRef } from 'react'

// The hidden door: five taps on the wordmark inside this window opens the vortex.
const SECRET_TAPS = 5
const SECRET_WINDOW_MS = 2_500

interface OtoMarkProps {
  ledOn?: boolean
  /** Invoked after the 5-tap easter-egg sequence. Omit to disable the secret. */
  onSecret?: () => void
}

/** The "◉ oto" wordmark used across panel headers. */
export function OtoMark({ ledOn = false, onSecret }: OtoMarkProps) {
  const tapsRef = useRef<number[]>([])

  const handleClick = () => {
    if (!onSecret) return
    const now = Date.now()
    const taps = tapsRef.current.filter(t => now - t < SECRET_WINDOW_MS)
    taps.push(now)
    tapsRef.current = taps
    if (taps.length >= SECRET_TAPS) {
      tapsRef.current = []
      onSecret()
    }
  }

  return (
    <span className="oto-mark" onClick={onSecret ? handleClick : undefined}>
      <span className="oto-led" data-on={ledOn} />
      oto
    </span>
  )
}
