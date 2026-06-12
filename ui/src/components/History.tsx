import { useEffect, useState } from 'react'
import type { HistoryItem, HistoryPayload } from '../../../src/types'
import { formatTimecode, relativeDate } from '../format'
import { TrashIcon } from './Icons'
import { OtoMark } from './Mark'

const CONFIRM_TIMEOUT_MS = 4_000

export type HistoryStatus = 'idle' | 'loading' | 'loading-more' | 'error'

interface HistoryViewProps {
  history: HistoryPayload | null
  status: HistoryStatus
  actionError: string | null
  activeId: string | null
  rowBusyId: string | null
  deletingId: string | null
  hasTrack: boolean
  onBack: () => void
  onClose: () => void
  onPlayItem: (item: HistoryItem) => void
  onDelete: (id: string) => void
  onLoadMore: () => void
  onRetry: () => void
  /** Open the voice rack (samples + favorite picker). */
  onVoices: () => void
  onVortex: () => void
}

export function HistoryView({
  history,
  status,
  actionError,
  activeId,
  rowBusyId,
  deletingId,
  hasTrack,
  onBack,
  onClose,
  onPlayItem,
  onDelete,
  onLoadMore,
  onRetry,
  onVoices,
  onVortex,
}: HistoryViewProps) {
  // Two-step delete confirm (window.confirm is blocked in sandboxed iframes).
  const [armedId, setArmedId] = useState<string | null>(null)

  useEffect(() => {
    if (!armedId) return
    const timer = window.setTimeout(() => setArmedId(null), CONFIRM_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [armedId])

  const items = history?.items ?? []
  const remaining = history ? Math.max(0, history.total - items.length) : 0

  let body
  if (status === 'loading' && !history) {
    body = (
      <ul className="oto-list" aria-busy="true">
        {[0, 1, 2].map(i => (
          <li key={i} className="oto-row oto-row-skeleton">
            <div className="oto-sk" style={{ width: `${68 - i * 14}%`, height: 11 }} />
            <div className="oto-sk" style={{ width: 96, height: 9 }} />
          </li>
        ))}
      </ul>
    )
  } else if (status === 'error' && !history) {
    body = (
      <div className="oto-empty">
        <p>Couldn&rsquo;t load your archive.</p>
        <button type="button" className="oto-more" onClick={onRetry}>
          retry
        </button>
      </div>
    )
  } else if (items.length === 0) {
    body = (
      <div className="oto-empty">
        <div className="oto-empty-reel" aria-hidden="true">
          ◉&thinsp;──────&thinsp;◉
        </div>
        <p>Nothing on tape yet.</p>
        <p className="oto-empty-sub">Ask for something to be read aloud and it lands here.</p>
      </div>
    )
  } else {
    body = (
      <>
        <ul className="oto-list">
          {items.map(item => (
            <HistoryRow
              key={item.id}
              item={item}
              active={item.id === activeId}
              busy={rowBusyId === item.id}
              deleting={deletingId === item.id}
              armed={armedId === item.id}
              onPlay={() => onPlayItem(item)}
              onArm={() => setArmedId(item.id)}
              onDisarm={() => setArmedId(null)}
              onConfirmDelete={() => {
                setArmedId(null)
                onDelete(item.id)
              }}
            />
          ))}
        </ul>
        {remaining > 0 &&
          (status === 'error' ? (
            <div className="oto-error" role="alert">
              <span>Couldn&rsquo;t load more</span>
              <button type="button" className="oto-ghost" onClick={onLoadMore}>
                retry
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="oto-more"
              onClick={onLoadMore}
              disabled={status === 'loading-more'}
            >
              {status === 'loading-more' ? 'loading…' : `load more · ${remaining} left`}
            </button>
          ))}
      </>
    )
  }

  return (
    <section className="oto-panel" aria-label="oto history">
      <header className="oto-bar">
        {hasTrack ? (
          <button type="button" className="oto-ghost oto-back" onClick={onBack}>
            ‹ player
          </button>
        ) : (
          <OtoMark onSecret={onVortex} />
        )}
        <span className="oto-bar-spacer" />
        {history && <span className="oto-count">{history.total} saved</span>}
        <button
          type="button"
          className="oto-ghost"
          onClick={onVoices}
          aria-label="Browse voices"
          title="Browse voices"
        >
          ♪ voices
        </button>
        <button type="button" className="oto-ghost oto-x" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {actionError && (
        <div className="oto-error" role="alert">
          {actionError}
        </div>
      )}

      {body}
    </section>
  )
}

interface HistoryRowProps {
  item: HistoryItem
  active: boolean
  busy: boolean
  deleting: boolean
  armed: boolean
  onPlay: () => void
  onArm: () => void
  onDisarm: () => void
  onConfirmDelete: () => void
}

function HistoryRow({
  item,
  active,
  busy,
  deleting,
  armed,
  onPlay,
  onArm,
  onDisarm,
  onConfirmDelete,
}: HistoryRowProps) {
  return (
    <li className="oto-row" data-active={active}>
      <button
        type="button"
        className="oto-row-main"
        onClick={onPlay}
        // Dead rows aren't playable; processing rows open the render view.
        disabled={busy || deleting || item.status === 'error'}
      >
        <span className="oto-row-title">{item.title}</span>
        <span className="oto-row-sub">
          {item.voice} · {relativeDate(item.createdAt)} ·{' '}
          {item.status === 'processing' ? (
            <span className="oto-row-state" data-state="processing">
              <span className="oto-status-dot" aria-hidden="true" />
              rendering
            </span>
          ) : item.status === 'error' ? (
            <span className="oto-row-state" data-state="error">
              error
            </span>
          ) : (
            formatTimecode(item.durationSec)
          )}
        </span>
      </button>
      <span className="oto-row-actions">
        {busy || deleting ? (
          <span className="oto-spin" role="status" aria-label={deleting ? 'Deleting' : 'Loading'} />
        ) : armed ? (
          <span className="oto-confirm">
            <button type="button" className="oto-confirm-yes" onClick={onConfirmDelete}>
              delete
            </button>
            <button type="button" className="oto-confirm-no" onClick={onDisarm}>
              keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="oto-icon-btn oto-del"
            onClick={onArm}
            aria-label={`Delete "${item.title}"`}
          >
            <TrashIcon />
          </button>
        )}
      </span>
    </li>
  )
}
