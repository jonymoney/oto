import type { PlayerPayload } from '../../../src/types'
import { formatTimecode, relativeDate } from '../format'
import type { AudioEngine } from '../useAudioEngine'
import { PauseIcon, PlayIcon } from './Icons'
import { OtoMark } from './Mark'
import { Waveform } from './Waveform'

interface PlayerViewProps {
  track: PlayerPayload
  engine: AudioEngine
  onClose: () => void
  onHistory: () => void
  onVortex: () => void
}

export function PlayerView({ track, engine, onClose, onHistory, onVortex }: PlayerViewProps) {
  const { state } = engine
  const duration = state.duration ?? track.durationSec

  return (
    <section className="oto-panel" aria-label="oto audio player">
      <header className="oto-bar">
        <OtoMark ledOn={state.playing} onSecret={onVortex} />
        <span className="oto-bar-spacer" />
        <button type="button" className="oto-ghost" onClick={onHistory}>
          history
        </button>
        <button type="button" className="oto-ghost oto-x" onClick={onClose} aria-label="Close player">
          ✕
        </button>
      </header>

      <h1 className="oto-title" title={track.title}>
        {track.title}
      </h1>
      <div className="oto-meta">
        <span className="oto-chip">{track.voice}</span>
        <span>{relativeDate(track.createdAt)}</span>
        {track.deduped && (
          <span className="oto-tag" title="Replayed from your library — not regenerated">
            library
          </span>
        )}
      </div>

      <div className="oto-transport">
        <button
          type="button"
          className="oto-play"
          data-playing={state.playing}
          onClick={engine.toggle}
          aria-label={state.playing ? 'Pause' : 'Play'}
        >
          {state.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <Waveform
          seedId={track.id}
          position={state.position}
          duration={duration}
          playing={state.playing}
          busy={state.busy}
          onSeek={engine.seek}
        />
        <div className="oto-clock" aria-hidden="true">
          <span className="oto-clock-cur">{formatTimecode(state.position)}</span>
          <span className="oto-clock-sep">/</span>
          <span>{formatTimecode(duration)}</span>
        </div>
      </div>

      {state.error && (
        <div className="oto-error" role="alert">
          <span>{state.error}</span>
          <button type="button" className="oto-ghost" onClick={engine.retry}>
            retry
          </button>
        </div>
      )}
    </section>
  )
}
