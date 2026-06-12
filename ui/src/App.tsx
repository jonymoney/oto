import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react'
import type {
  HistoryItem,
  HistoryPayload,
  PlayerPayload,
  StatusPayload,
  VoicesPayload,
} from '../../src/types'
import { callTool, callToolAck, parseUiPayload, resultText } from './bridge'
import type { UiPayload } from './bridge'
import { useAudioEngine } from './useAudioEngine'
import { PlayerView } from './components/Player'
import { HistoryView } from './components/History'
import type { HistoryStatus } from './components/History'
import { ProcessingView } from './components/Processing'
import type { ProcessingJob } from './components/Processing'
import { VoicesView } from './components/Voices'
import type { VoicesStatus } from './components/Voices'
import { VortexView } from './components/Vortex'

const PAGE_SIZE = 20
const POLL_MS = 2_500
// Transient transport hiccups are tolerated for this many consecutive polls.
const MAX_POLL_FAILURES = 4

type View = 'boot' | 'player' | 'history' | 'processing' | 'voices' | 'vortex' | 'closed'
type Theme = 'light' | 'dark'

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function OtoApp() {
  const [view, setView] = useState<View>('boot')
  const [theme, setTheme] = useState<Theme>(systemTheme)
  const [track, setTrack] = useState<PlayerPayload | null>(null)
  const [processing, setProcessing] = useState<ProcessingJob | null>(null)
  const [readyPulse, setReadyPulse] = useState(false)
  const [history, setHistory] = useState<HistoryPayload | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('idle')
  const [voices, setVoices] = useState<VoicesPayload | null>(null)
  const [voicesStatus, setVoicesStatus] = useState<VoicesStatus>('idle')
  const [actionError, setActionError] = useState<string | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState<string | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const [vortexSeed, setVortexSeed] = useState(0)
  const [incoming, setIncoming] = useState<UiPayload | null>(null)

  const { app, isConnected, error: connectError } = useApp({
    appInfo: { name: 'oto', version: '0.1.0' },
    capabilities: {},
    onAppCreated(created) {
      // Handlers must be registered before the initialize handshake completes.
      created.ontoolresult = result => {
        const payload = parseUiPayload(result)
        if (payload) setIncoming(payload)
        // Error result (or unparseable payload): surface it instead of
        // leaving the boot skeleton up forever.
        else setToolError(resultText(result) || 'The tool returned something oto can’t display')
      }
      created.ontoolcancelled = params => setCancelReason(params.reason ?? 'cancelled by host')
      created.onhostcontextchanged = ctx => {
        if (ctx.theme) setTheme(ctx.theme)
      }
    },
  })
  useHostStyles(app, app?.getHostContext())

  const engine = useAudioEngine(app)
  const engineRef = useRef(engine)
  engineRef.current = engine
  const trackIdRef = useRef<string | null>(null)
  trackIdRef.current = track?.id ?? null
  const processingRef = useRef(processing)
  processingRef.current = processing
  const voicesRef = useRef(voices)
  voicesRef.current = voices
  // Where "eject" lands when the vortex closes.
  const vortexReturnRef = useRef<View>('history')
  // Where "back" lands when the voice rack closes.
  const voicesReturnRef = useRef<View>('history')

  useEffect(() => {
    const initial = app?.getHostContext()?.theme
    if (initial) setTheme(initial)
  }, [app, isConnected])

  // Open the vortex; audio is deliberately left alone — it's a visualizer
  // companion, not a player state. Omitting the seed rolls a fresh one (the
  // local easter-egg path).
  const openVortex = useCallback((seed?: number) => {
    setVortexSeed(seed ?? Math.floor(Math.random() * 2 ** 31))
    setView(v => {
      if (v !== 'vortex') vortexReturnRef.current = v
      return 'vortex'
    })
  }, [])

  // Apply the host-delivered tool result (the discriminated union on `kind`).
  useEffect(() => {
    if (!incoming) return
    setIncoming(null)
    setCancelReason(null)
    setToolError(null)
    if (incoming.kind === 'audio') {
      setTrack(incoming)
      setView('player')
      engineRef.current.load(incoming)
    } else if (incoming.kind === 'processing') {
      setProcessing({
        id: incoming.id,
        title: incoming.title,
        charCount: incoming.charCount,
        chunksDone: incoming.chunksDone,
        chunksTotal: incoming.chunksTotal,
        error: null,
        stalled: false,
      })
      setView('processing')
    } else if (incoming.kind === 'history') {
      setHistory(incoming)
      setHistoryStatus('idle')
      setView('history')
    } else if (incoming.kind === 'voices') {
      // The gallery — via the voices tool or the listen-first elicitation path.
      setVoices(incoming)
      setVoicesStatus('idle')
      setView(v => {
        if (v !== 'voices') voicesReturnRef.current = v
        return 'voices'
      })
    } else {
      openVortex(incoming.seed)
    }
  }, [incoming, openVortex])

  // Poll get_audio_status while the processing view is up. The loop stops on
  // view change/unmount, idles while the tab is hidden, and only re-keys on
  // identity/terminal fields — chunk counts update inside the closure, so
  // putting them in the deps would restart the timer every poll.
  useEffect(() => {
    if (view !== 'processing' || !app || !processing || processing.error || processing.stalled)
      return
    const id = processing.id
    let cancelled = false
    let timer = 0
    let failures = 0

    const isHidden = () => {
      try {
        return document.hidden
      } catch {
        return false
      }
    }

    const markHistory = (patch: Partial<HistoryItem>) =>
      setHistory(prev =>
        prev
          ? { ...prev, items: prev.items.map(i => (i.id === id ? { ...i, ...patch } : i)) }
          : prev,
      )

    const tick = async () => {
      if (cancelled) return
      if (isHidden()) {
        timer = window.setTimeout(() => void tick(), POLL_MS)
        return
      }
      try {
        const status = await callTool<StatusPayload>(app, 'get_audio_status', { id })
        if (cancelled) return
        failures = 0
        if (status.status === 'ready' && status.audio) {
          const audio = status.audio
          setProcessing(null)
          markHistory({ status: 'ready', durationSec: audio.durationSec })
          setTrack(audio)
          setView('player')
          setReadyPulse(true)
          // Deliberately no autoplay — the arriving track waits for the play button.
          engineRef.current.load(audio)
          return
        }
        if (status.status !== 'processing') {
          // 'error', or a malformed 'ready' without audio: the row is dead.
          setProcessing(p => (p?.id === id ? { ...p, error: status.error ?? 'Generation failed' } : p))
          markHistory({ status: 'error' })
          return
        }
        setProcessing(p =>
          p?.id === id ? { ...p, chunksDone: status.chunksDone, chunksTotal: status.chunksTotal } : p,
        )
      } catch {
        if (cancelled) return
        failures += 1
        if (failures >= MAX_POLL_FAILURES) {
          setProcessing(p => (p?.id === id ? { ...p, stalled: true } : p))
          return
        }
      }
      timer = window.setTimeout(() => void tick(), POLL_MS)
    }

    const onVisibility = () => {
      if (cancelled || isHidden()) return
      window.clearTimeout(timer)
      void tick()
    }

    void tick()
    // visibilitychange may be unavailable in the sandbox — degrade to plain polling.
    try {
      document.addEventListener('visibilitychange', onVisibility)
    } catch {
      // ignore
    }
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      try {
        document.removeEventListener('visibilitychange', onVisibility)
      } catch {
        // ignore
      }
    }
  }, [view, app, processing?.id, processing?.error, processing?.stalled])

  // Brief amber pulse on the player chassis when a background render arrives.
  useEffect(() => {
    if (!readyPulse) return
    const timer = window.setTimeout(() => setReadyPulse(false), 1_600)
    return () => window.clearTimeout(timer)
  }, [readyPulse])

  const fetchHistory = useCallback(
    async (offset: number) => {
      if (!app) return
      setActionError(null)
      setHistoryStatus(offset === 0 ? 'loading' : 'loading-more')
      try {
        const page = await callTool<HistoryPayload>(app, 'get_history', {
          limit: PAGE_SIZE,
          offset,
        })
        setHistory(prev => {
          if (offset > 0 && prev) {
            // Offset paging can shift while new generations land server-side;
            // drop rows we already have so ids (and React keys) stay unique.
            const seen = new Set(prev.items.map(i => i.id))
            return {
              kind: 'history',
              items: [...prev.items, ...page.items.filter(i => !seen.has(i.id))],
              total: page.total,
            }
          }
          return page
        })
        setHistoryStatus('idle')
      } catch {
        setHistoryStatus('error')
      }
    },
    [app],
  )

  const openHistory = useCallback(() => {
    setView('history')
    if (!history) void fetchHistory(0)
  }, [history, fetchHistory])

  /** Re-request the gallery (fresh presigned sample URLs) without UI churn. */
  const refreshVoices = useCallback(async (): Promise<VoicesPayload> => {
    if (!app) throw new Error('oto is not connected')
    const payload = await callTool<VoicesPayload>(app, 'voices', {})
    setVoices(payload)
    return payload
  }, [app])

  const fetchVoices = useCallback(async () => {
    setVoicesStatus('loading')
    try {
      await refreshVoices()
      setVoicesStatus('idle')
    } catch {
      setVoicesStatus('error')
    }
  }, [refreshVoices])

  const openVoices = useCallback(() => {
    setView(v => {
      if (v !== 'voices') voicesReturnRef.current = v
      return 'voices'
    })
    if (!voicesRef.current) void fetchVoices()
  }, [fetchVoices])

  const exitVoices = useCallback(() => {
    const back = voicesReturnRef.current
    if (back === 'processing' && processingRef.current) setView('processing')
    else if (back === 'player' && trackIdRef.current) setView('player')
    else if (back === 'closed') setView('closed')
    else if (back === 'history') openHistory()
    // Arrived straight from boot (the listen-first path): land somewhere sane.
    else if (trackIdRef.current) setView('player')
    else openHistory()
  }, [openHistory])

  /** Optimistic favorite: the star moves now, reverts if the save fails. */
  const saveFavorite = useCallback(
    async (voice: string) => {
      if (!app) throw new Error('oto is not connected')
      const previous = voicesRef.current?.favorite ?? null
      setVoices(prev => (prev ? { ...prev, favorite: voice } : prev))
      try {
        await callToolAck(app, 'set_favorite_voice', { voice })
      } catch (err) {
        // Revert only if nothing newer landed meanwhile.
        setVoices(prev =>
          prev && prev.favorite === voice ? { ...prev, favorite: previous } : prev,
        )
        throw err
      }
    },
    [app],
  )

  const exitVortex = useCallback(() => {
    const back = vortexReturnRef.current
    if (back === 'processing' && processingRef.current) setView('processing')
    else if (back === 'player' && trackIdRef.current) setView('player')
    else if (back === 'closed') setView('closed')
    else if (back === 'voices') setView('voices')
    else if (back === 'history') openHistory()
    // Arrived straight from boot (server-driven vortex): land somewhere sane.
    else if (trackIdRef.current) setView('player')
    else openHistory()
  }, [openHistory])

  const playItem = useCallback(
    async (item: HistoryItem) => {
      if (!app || rowBusyId) return
      if (item.status === 'processing') {
        // Still rendering — show its progress instead of trying to play.
        // Chunk counts are unknown until the first poll; keep an existing job
        // for the same id so progress (or a terminal error) isn't reset.
        setProcessing(prev =>
          prev?.id === item.id
            ? prev
            : {
                id: item.id,
                title: item.title,
                charCount: item.charCount,
                chunksDone: 0,
                chunksTotal: 0,
                error: null,
                stalled: false,
              },
        )
        setView('processing')
        return
      }
      if (item.status === 'error') return
      setRowBusyId(item.id)
      setActionError(null)
      try {
        const fresh = await callTool<PlayerPayload>(app, 'get_audio_url', { id: item.id })
        setTrack(fresh)
        setView('player')
        engineRef.current.load(fresh, { autoplay: true })
      } catch {
        setActionError('Could not load that recording — try again')
      } finally {
        setRowBusyId(null)
      }
    },
    [app, rowBusyId],
  )

  const deleteItem = useCallback(
    async (id: string) => {
      if (!app || deletingId) return
      setDeletingId(id)
      setActionError(null)
      try {
        await callTool<{ ok: true; id: string }>(app, 'delete_audio', { id })
        setHistory(prev =>
          prev
            ? { ...prev, items: prev.items.filter(i => i.id !== id), total: Math.max(0, prev.total - 1) }
            : prev,
        )
        if (trackIdRef.current === id) {
          engineRef.current.unload()
          setTrack(null)
        }
        if (processingRef.current?.id === id) setProcessing(null)
      } catch {
        setActionError('Delete failed — the recording is untouched')
      } finally {
        setDeletingId(null)
      }
    },
    [app, deletingId],
  )

  // Terminal-error affordance: drop the dead row and land in the archive.
  const discardProcessing = useCallback(() => {
    const id = processingRef.current?.id
    setProcessing(null)
    openHistory()
    if (id) void deleteItem(id)
  }, [deleteItem, openHistory])

  const retryPolling = useCallback(() => {
    // Clearing `stalled` re-keys the polling effect, which resumes the loop.
    setProcessing(p => (p?.stalled ? { ...p, stalled: false } : p))
  }, [])

  const closeWidget = useCallback(() => {
    engineRef.current.pause()
    setView('closed')
  }, [])

  const reopen = useCallback(() => {
    if (processingRef.current) setView('processing')
    else setView(trackIdRef.current ? 'player' : 'history')
  }, [])

  const backToPlayer = useCallback(() => setView('player'), [])

  let body: ReactNode
  if (connectError) {
    body = (
      <MessagePanel kind="error" text="Couldn't connect to the host" detail={connectError.message} />
    )
  } else if (view === 'boot') {
    body = cancelReason ? (
      <MessagePanel kind="muted" text="Generation cancelled" detail={cancelReason} />
    ) : toolError ? (
      <MessagePanel
        kind="error"
        text="That didn’t work"
        detail={toolError}
        action={
          <button type="button" className="oto-more" onClick={openHistory}>
            open history
          </button>
        }
      />
    ) : (
      <BootSkeleton />
    )
  } else if (view === 'closed') {
    body = <ClosedPill title={processing?.title ?? track?.title ?? 'archive'} onOpen={reopen} />
  } else if (view === 'vortex') {
    body = <VortexView seed={vortexSeed} playing={engine.state.playing} onExit={exitVortex} />
  } else if (view === 'processing' && processing) {
    body = (
      <ProcessingView
        job={processing}
        onHistory={openHistory}
        onClose={closeWidget}
        onVortex={() => openVortex()}
        onDiscard={discardProcessing}
        onRetryPoll={retryPolling}
      />
    )
  } else if (view === 'voices') {
    body = (
      <VoicesView
        voices={voices}
        status={voicesStatus}
        onSetFavorite={saveFavorite}
        onRefreshUrls={refreshVoices}
        onRetry={() => void fetchVoices()}
        onPauseEngine={() => engineRef.current.pause()}
        onBack={exitVoices}
        onClose={closeWidget}
        onVortex={() => openVortex()}
      />
    )
  } else if (view === 'history' || !track) {
    body = (
      <HistoryView
        history={history}
        status={historyStatus}
        actionError={actionError}
        activeId={engine.state.trackId}
        rowBusyId={rowBusyId}
        deletingId={deletingId}
        hasTrack={Boolean(track)}
        onBack={backToPlayer}
        onClose={closeWidget}
        onPlayItem={playItem}
        onDelete={deleteItem}
        onLoadMore={() => void fetchHistory(history?.items.length ?? 0)}
        onRetry={() => void fetchHistory(0)}
        onVoices={openVoices}
        onVortex={() => openVortex()}
      />
    )
  } else {
    body = (
      <PlayerView
        track={track}
        engine={engine}
        pulse={readyPulse}
        onClose={closeWidget}
        onHistory={openHistory}
        onVortex={() => openVortex()}
      />
    )
  }

  return (
    <div className="oto" data-theme={theme}>
      <audio ref={engine.audioRef} hidden preload="metadata" />
      {body}
    </div>
  )
}

function BootSkeleton() {
  return (
    <section className="oto-panel" aria-busy="true" aria-label="oto loading">
      <header className="oto-bar">
        <span className="oto-mark">
          <span className="oto-led" />
          oto
        </span>
        <span className="oto-bar-spacer" />
      </header>
      <div className="oto-sk" style={{ width: '58%', height: 14, marginBottom: 12 }} />
      <div className="oto-boot-row">
        <div className="oto-sk" style={{ width: 38, height: 38, borderRadius: '50%' }} />
        <div className="oto-sk" style={{ flex: 1, height: 26 }} />
        <div className="oto-sk" style={{ width: 64, height: 12 }} />
      </div>
    </section>
  )
}

function MessagePanel({
  kind,
  text,
  detail,
  action,
}: {
  kind: 'error' | 'muted'
  text: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <section className="oto-panel oto-message" data-kind={kind} role={kind === 'error' ? 'alert' : undefined}>
      <header className="oto-bar">
        <span className="oto-mark">
          <span className="oto-led" />
          oto
        </span>
      </header>
      <p className="oto-message-text">{text}</p>
      {detail && <p className="oto-message-detail">{detail}</p>}
      {action}
    </section>
  )
}

function ClosedPill({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <button type="button" className="oto-pill" onClick={onOpen} aria-label={`Reopen oto: ${title}`}>
      <span className="oto-led" />
      <span className="oto-pill-brand">oto</span>
      <span className="oto-pill-title">{title}</span>
      <span className="oto-pill-open">open</span>
    </button>
  )
}
