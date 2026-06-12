/** A generated audio, as stored in Postgres. */
export interface AudioRecord {
  id: string
  userId: string
  /** sha256 of `${model}|${voice}|${format}|${text}` — the generate-once dedup key. */
  textHash: string
  text: string
  /** Display title: first ~60 chars of the source text. */
  title: string
  voice: string
  model: string
  format: string
  /** Bucket object key: audio/<userId>/<textHash>.mp3 */
  objectKey: string
  durationSec: number | null
  charCount: number
  createdAt: string
}

/** Fields required to insert a new audio row. */
export type NewAudio = Omit<AudioRecord, 'id' | 'createdAt'>

/** structuredContent payload for the player UI after text_to_speech. */
export interface PlayerPayload {
  kind: 'audio'
  id: string
  title: string
  audioUrl: string
  durationSec: number | null
  voice: string
  createdAt: string
  /** True when the audio was served from storage instead of generated. */
  deduped: boolean
}

/** One item in the history list (no URL — presigned on demand). */
export interface HistoryItem {
  id: string
  title: string
  durationSec: number | null
  voice: string
  charCount: number
  createdAt: string
}

/** structuredContent payload for the history view. */
export interface HistoryPayload {
  kind: 'history'
  items: HistoryItem[]
  total: number
}
