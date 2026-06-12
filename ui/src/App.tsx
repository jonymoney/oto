import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react'
import type { HistoryItem, HistoryPayload, PlayerPayload } from '../../src/types'
import { callTool, parseUiPayload } from './bridge'
import { useAudioEngine } from './useAudioEngine'
import { PlayerView } from './components/Player'
import { HistoryView } from './components/History'
import type { HistoryStatus } from './components/History'

const PAGE_SIZE = 20

type View = 'boot' | 'player' | 'history' | 'closed'
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
  const [history, setHistory] = useState<HistoryPayload | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('idle')
  const [actionError, setActionError] = useState<string | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<PlayerPayload | HistoryPayload | null>(null)

  const { app, isConnected, error: connectError } = useApp({
    appInfo: { name: 'oto', version: '0.1.0' },
    capabilities: {},
    onAppCreated(created) {
      // Handlers must be registered before the initialize handshake completes.
      created.ontoolresult = result => {
        const payload = parseUiPayload(result)
        if (payload) setIncoming(payload)
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

  useEffect(() => {
    const initial = app?.getHostContext()?.theme
    if (initial) setTheme(initial)
  }, [app, isConnected])

  // Apply the host-delivered tool result (the discriminated union on `kind`).
  useEffect(() => {
    if (!incoming) return
    setIncoming(null)
    setCancelReason(null)
    if (incoming.kind === 'audio') {
      setTrack(incoming)
      setView('player')
      engineRef.current.load(incoming)
    } else {
      setHistory(incoming)
      setHistoryStatus('idle')
      setView('history')
    }
  }, [incoming])

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
        setHistory(prev =>
          offset > 0 && prev
            ? { kind: 'history', items: [...prev.items, ...page.items], total: page.total }
            : page,
        )
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

  const playItem = useCallback(
    async (item: HistoryItem) => {
      if (!app || rowBusyId) return
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
      } catch {
        setActionError('Delete failed — the recording is untouched')
      } finally {
        setDeletingId(null)
      }
    },
    [app, deletingId],
  )

  const closeWidget = useCallback(() => {
    engineRef.current.pause()
    setView('closed')
  }, [])

  const reopen = useCallback(() => {
    setView(trackIdRef.current ? 'player' : 'history')
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
    ) : (
      <BootSkeleton />
    )
  } else if (view === 'closed') {
    body = <ClosedPill title={track?.title ?? 'archive'} onOpen={reopen} />
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
      />
    )
  } else {
    body = <PlayerView track={track} engine={engine} onClose={closeWidget} onHistory={openHistory} />
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
}: {
  kind: 'error' | 'muted'
  text: string
  detail?: string
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
