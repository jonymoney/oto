import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoicesPayload } from '../../../src/types'
import { announcePlayback, onOtherPlayback } from '../lock'
import { PlayIcon, StopIcon } from './Icons'
import { OtoMark } from './Mark'

// How long the "★ saved" confirmation bar stays up.
const SAVED_BAR_MS = 6_000

export type VoicesStatus = 'idle' | 'loading' | 'error'

type Note = { kind: 'saved'; voice: string } | { kind: 'error'; text: string }

interface VoicesViewProps {
  voices: VoicesPayload | null
  status: VoicesStatus
  /** Persist the favorite. App applies the optimistic flip and reverts on throw. */
  onSetFavorite: (voice: string) => Promise<void>
  /** Re-request the gallery — fresh presigned URLs for expired samples. */
  onRefreshUrls: () => Promise<VoicesPayload>
  onRetry: () => void
  /** A sample takes the stage: the main deck pauses and never auto-resumes. */
  onPauseEngine: () => void
  onBack: () => void
  onClose: () => void
  onVortex: () => void
}

/**
 * The studio's voice rack: every voice on a compact card with a playable
 * sample and a "make this my voice" star. Samples go through one shared
 * <audio> element owned here — never the main engine.
 */
export function VoicesView({
  voices,
  status,
  onSetFavorite,
  onRefreshUrls,
  onRetry,
  onPauseEngine,
  onBack,
  onClose,
  onVortex,
}: VoicesViewProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const voicesRef = useRef(voices)
  voicesRef.current = voices
  const refreshRef = useRef(onRefreshUrls)
  refreshRef.current = onRefreshUrls

  // The sample being auditioned; `retried` flags the one-shot URL refresh.
  const attemptRef = useRef<{ voice: string; retried: boolean } | null>(null)
  const savingRef = useRef(false)

  const [playingVoice, setPlayingVoice] = useState<string | null>(null)
  const [busyVoice, setBusyVoice] = useState<string | null>(null)
  const [savingVoice, setSavingVoice] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)

  // Autoplay veto (NotAllowedError) settles back to stopped — the play button
  // is the affordance. Real media failures arrive via the 'error' event.
  const settleRejectedPlay = useCallback((err: unknown) => {
    if ((err as DOMException | null)?.name === 'NotAllowedError') {
      attemptRef.current = null
      setPlayingVoice(null)
      setBusyVoice(null)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const stop = () => {
      attemptRef.current = null
      setPlayingVoice(null)
      setBusyVoice(null)
    }
    const onEnded = stop
    const onWaiting = () => setBusyVoice(attemptRef.current?.voice ?? null)
    const onPlaying = () => setBusyVoice(null)

    // Presigned sample URLs expire in long-lived widgets: on the first media
    // error re-request the gallery once, swap in the fresh URL, and retry.
    const onError = () => {
      const attempt = attemptRef.current
      if (!attempt) return
      if (attempt.retried) {
        stop()
        setNote({ kind: 'error', text: 'Sample unavailable — try again in a moment' })
        return
      }
      attempt.retried = true
      setBusyVoice(attempt.voice)
      void (async () => {
        try {
          const fresh = await refreshRef.current()
          if (attemptRef.current !== attempt) return // user moved on
          const sample = fresh.voices.find(s => s.voice === attempt.voice)
          if (!sample) throw new Error('voice missing from refreshed gallery')
          audio.src = sample.sampleUrl
          audio.load()
          void audio.play().catch(settleRejectedPlay)
        } catch {
          if (attemptRef.current !== attempt) return
          stop()
          setNote({ kind: 'error', text: 'Could not refresh the samples — try again' })
        }
      })()
    }

    audio.addEventListener('ended', onEnded)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('error', onError)
      audio.pause()
    }
  }, [settleRejectedPlay])

  // Courtesy lock: a sibling oto instance started playing — stop the audition.
  useEffect(
    () =>
      onOtherPlayback(() => {
        attemptRef.current = null
        audioRef.current?.pause()
        setPlayingVoice(null)
        setBusyVoice(null)
      }),
    [],
  )

  // The saved bar dismisses itself; errors stay until the next action.
  useEffect(() => {
    if (note?.kind !== 'saved') return
    const timer = window.setTimeout(
      () => setNote(n => (n?.kind === 'saved' ? null : n)),
      SAVED_BAR_MS,
    )
    return () => window.clearTimeout(timer)
  }, [note])

  const toggleSample = (voice: string) => {
    const audio = audioRef.current
    if (!audio) return
    if (playingVoice === voice) {
      attemptRef.current = null
      audio.pause()
      setPlayingVoice(null)
      setBusyVoice(null)
      return
    }
    const url = voicesRef.current?.voices.find(s => s.voice === voice)?.sampleUrl
    if (!url) return
    // The audition takes the stage; the main deck never auto-resumes.
    onPauseEngine()
    announcePlayback()
    attemptRef.current = { voice, retried: false }
    setNote(n => (n?.kind === 'error' ? null : n))
    setPlayingVoice(voice)
    setBusyVoice(voice)
    audio.src = url
    audio.load()
    // play() during load keeps the user-activation grant (same as the engine).
    void audio.play().catch(settleRejectedPlay)
  }

  // Multi-tap safe: one save in flight at a time, re-tapping the favorite no-ops.
  const makeFavorite = (voice: string) => {
    if (savingRef.current) return
    if (voicesRef.current?.favorite === voice) return
    savingRef.current = true
    setSavingVoice(voice)
    setNote(null)
    void onSetFavorite(voice)
      .then(() => setNote({ kind: 'saved', voice }))
      .catch(() => setNote({ kind: 'error', text: 'Couldn’t save your voice — try again' }))
      .finally(() => {
        savingRef.current = false
        setSavingVoice(null)
      })
  }

  let body
  if (!voices) {
    body =
      status === 'error' ? (
        <div className="oto-empty">
          <p>Couldn&rsquo;t load the voice rack.</p>
          <button type="button" className="oto-more" onClick={onRetry}>
            retry
          </button>
        </div>
      ) : (
        <ul className="oto-voice-grid" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <li key={i} className="oto-voice">
              <div className="oto-sk" style={{ width: 26, height: 26, borderRadius: '50%' }} />
              <div className="oto-sk" style={{ width: `${72 - (i % 3) * 16}%`, height: 10 }} />
            </li>
          ))}
        </ul>
      )
  } else if (voices.voices.length === 0) {
    body = (
      <div className="oto-empty">
        <p>The voice rack is empty.</p>
        <p className="oto-empty-sub">Samples are still being provisioned — try again shortly.</p>
        <button type="button" className="oto-more" onClick={onRetry}>
          retry
        </button>
      </div>
    )
  } else {
    body = (
      <ul className="oto-voice-grid" aria-label="Voice samples">
        {voices.voices.map(sample => (
          <VoiceCard
            key={sample.voice}
            voice={sample.voice}
            favorite={voices.favorite === sample.voice}
            playing={playingVoice === sample.voice}
            busy={busyVoice === sample.voice}
            saving={savingVoice === sample.voice}
            onToggle={() => toggleSample(sample.voice)}
            onFavorite={() => makeFavorite(sample.voice)}
          />
        ))}
      </ul>
    )
  }

  return (
    <section className="oto-panel" aria-label="oto voice gallery">
      <header className="oto-bar">
        <OtoMark ledOn={Boolean(playingVoice)} onSecret={onVortex} />
        <span className="oto-bar-spacer" />
        <span className="oto-count">{voices ? `${voices.voices.length} voices` : 'voices'}</span>
        <button type="button" className="oto-ghost oto-back" onClick={onBack}>
          ‹ back
        </button>
        <button type="button" className="oto-ghost oto-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {body}

      {note?.kind === 'saved' && (
        <p className="oto-voice-saved" role="status">
          ★ <span className="oto-voice-saved-name">{note.voice}</span> saved — ask oto to generate
          again and it will use it.
        </p>
      )}
      {note?.kind === 'error' && (
        <div className="oto-error" role="alert">
          {note.text}
        </div>
      )}

      <audio ref={audioRef} hidden preload="none" />
    </section>
  )
}

interface VoiceCardProps {
  voice: string
  favorite: boolean
  playing: boolean
  busy: boolean
  saving: boolean
  onToggle: () => void
  onFavorite: () => void
}

function VoiceCard({ voice, favorite, playing, busy, saving, onToggle, onFavorite }: VoiceCardProps) {
  return (
    <li className="oto-voice" data-fav={favorite} data-playing={playing}>
      <button
        type="button"
        className="oto-voice-play"
        data-playing={playing}
        onClick={onToggle}
        aria-label={playing ? `Stop the ${voice} sample` : `Play the ${voice} sample`}
      >
        {busy ? (
          <span className="oto-spin" role="status" aria-label="Loading sample" />
        ) : playing ? (
          <StopIcon />
        ) : (
          <PlayIcon />
        )}
      </button>
      <span className="oto-voice-info">
        <span className="oto-voice-name">{voice}</span>
        {favorite && <span className="oto-voice-tag">your voice</span>}
      </span>
      <span className="oto-voice-vu" data-live={playing && !busy} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <button
        type="button"
        className="oto-voice-star"
        onClick={onFavorite}
        disabled={saving}
        aria-pressed={favorite}
        aria-label={favorite ? `${voice} is your voice` : `Make ${voice} your voice`}
        title={favorite ? 'your voice' : 'make this my voice'}
      >
        {saving ? <span className="oto-spin" role="status" aria-label="Saving" /> : favorite ? '★' : '☆'}
      </button>
    </li>
  )
}
