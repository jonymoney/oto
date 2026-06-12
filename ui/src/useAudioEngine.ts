import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { App } from '@modelcontextprotocol/ext-apps/react'
import type { PlayerPayload } from '../../src/types'
import { callTool } from './bridge'
import { announcePlayback, onOtherPlayback } from './lock'

// Presigned URLs expire; after a media error we re-fetch one fresh URL, but
// never more often than this, so a genuinely broken file can't loop forever.
const REFRESH_COOLDOWN_MS = 8_000

export interface EngineState {
  trackId: string | null
  playing: boolean
  position: number
  duration: number | null
  /** Loading metadata, buffering, or refreshing an expired URL. */
  busy: boolean
  error: string | null
}

export interface AudioEngine {
  state: EngineState
  audioRef: MutableRefObject<HTMLAudioElement | null>
  load: (track: PlayerPayload, opts?: { autoplay?: boolean }) => void
  unload: () => void
  toggle: () => void
  pause: () => void
  seek: (seconds: number) => void
  retry: () => void
}

const IDLE: EngineState = {
  trackId: null,
  playing: false,
  position: 0,
  duration: null,
  busy: false,
  error: null,
}

export function useAudioEngine(app: App | null): AudioEngine {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const appRef = useRef(app)
  appRef.current = app

  const trackRef = useRef<PlayerPayload | null>(null)
  const playingRef = useRef(false)
  const lastPositionRef = useRef(0)
  const lastRefreshRef = useRef(0)
  const pendingResumeRef = useRef<{ at: number; play: boolean } | null>(null)

  const [state, setState] = useState<EngineState>(IDLE)

  const recover = useCallback(async () => {
    const audio = audioRef.current
    const track = trackRef.current
    if (!audio || !track) return
    const appNow = appRef.current
    if (!appNow) {
      setState(s => ({ ...s, busy: false, playing: false, error: 'Playback failed' }))
      return
    }
    const now = Date.now()
    if (now - lastRefreshRef.current < REFRESH_COOLDOWN_MS) {
      setState(s => ({ ...s, busy: false, playing: false, error: 'This audio is unavailable right now' }))
      return
    }
    lastRefreshRef.current = now
    const resumeAt = lastPositionRef.current
    const wasPlaying = playingRef.current
    setState(s => ({ ...s, busy: true, playing: false, error: null }))
    try {
      const fresh = await callTool<PlayerPayload>(appNow, 'get_audio_url', { id: track.id })
      trackRef.current = { ...track, audioUrl: fresh.audioUrl }
      pendingResumeRef.current = { at: resumeAt, play: wasPlaying }
      audio.src = fresh.audioUrl
      audio.load()
    } catch {
      setState(s => ({ ...s, busy: false, error: 'Could not refresh the audio link' }))
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTime = () => {
      lastPositionRef.current = audio.currentTime
      setState(s => ({ ...s, position: audio.currentTime }))
    }
    const onDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setState(s => ({ ...s, duration: audio.duration }))
      }
    }
    const onLoadedMetadata = () => {
      onDuration()
      const pending = pendingResumeRef.current
      pendingResumeRef.current = null
      if (pending) {
        if (pending.at > 0) {
          try {
            audio.currentTime = pending.at
          } catch {
            // not seekable yet — start over rather than fail
          }
        }
        if (pending.play) void audio.play().catch(() => {})
      }
      setState(s => ({ ...s, busy: false }))
    }
    const onPlay = () => {
      playingRef.current = true
      announcePlayback()
      setState(s => ({ ...s, playing: true, error: null }))
    }
    const onPause = () => {
      playingRef.current = false
      setState(s => ({ ...s, playing: false }))
    }
    const onEnded = () => {
      playingRef.current = false
      setState(s => ({ ...s, playing: false, position: s.duration ?? s.position }))
    }
    const onWaiting = () => setState(s => ({ ...s, busy: true }))
    const onReady = () => setState(s => ({ ...s, busy: false }))
    const onError = () => void recover()

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onReady)
    audio.addEventListener('playing', onReady)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onReady)
      audio.removeEventListener('playing', onReady)
      audio.removeEventListener('error', onError)
    }
  }, [recover])

  // Pause when a sibling oto instance starts playing.
  useEffect(() => onOtherPlayback(() => audioRef.current?.pause()), [])

  const load = useCallback((track: PlayerPayload, opts?: { autoplay?: boolean }) => {
    trackRef.current = track
    lastPositionRef.current = 0
    pendingResumeRef.current = null
    setState({
      trackId: track.id,
      playing: false,
      position: 0,
      duration: track.durationSec,
      busy: true,
      error: null,
    })
    const audio = audioRef.current
    if (!audio) return
    audio.src = track.audioUrl
    audio.load()
    // play() during load is fine — the browser starts as soon as it can,
    // and calling it synchronously keeps the user-activation grant.
    if (opts?.autoplay) void audio.play().catch(() => {})
  }, [])

  const unload = useCallback(() => {
    trackRef.current = null
    pendingResumeRef.current = null
    lastPositionRef.current = 0
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setState(IDLE)
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !trackRef.current) return
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0
      void audio.play().catch(() => {
        // NotAllowedError etc. — real media failures arrive via the error event
      })
    } else {
      audio.pause()
    }
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current
    const track = trackRef.current
    if (!audio || !track) return
    const limit =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : (track.durationSec ?? 0)
    if (limit <= 0) return
    const clamped = Math.min(Math.max(seconds, 0), limit)
    try {
      audio.currentTime = clamped
    } catch {
      return
    }
    lastPositionRef.current = clamped
    setState(s => ({ ...s, position: clamped }))
  }, [])

  const retry = useCallback(() => {
    lastRefreshRef.current = 0
    void recover()
  }, [recover])

  return useMemo(
    () => ({ state, audioRef, load, unload, toggle, pause, seek, retry }),
    [state, load, unload, toggle, pause, seek, retry],
  )
}
