export type AudioStatus = 'processing' | 'ready' | 'error'

/** A generated audio, as stored in Postgres. */
export interface AudioRecord {
  status: AudioStatus
  /** Total OpenAI chunks for this generation (null for legacy/sync rows). */
  chunksTotal: number | null
  chunksDone: number
  errorMessage: string | null
  id: string
  userId: string
  /** sha256 of `${model}|${voice}|${format}|${text}` — the generate-once dedup key. */
  textHash: string
  text: string
  /** Display title: first ~60 chars of the source text. */
  title: string
  /** Optional metadata supplied by Claude at generation time (not in the dedup hash). */
  summary: string | null
  /** A single emoji representing the audio. */
  emoji: string | null
  /** Detected language of the source text (e.g. "Spanish" or "es"). */
  language: string | null
  /** One-word mood used to tint the generative cover (e.g. "calm", "energetic"). */
  mood: string | null
  /** Up to ~6 short topic tags. */
  tags: string[]
  voice: string
  model: string
  format: string
  /** Bucket object key: audio/<userId>/<textHash>.mp3 */
  objectKey: string
  durationSec: number | null
  charCount: number
  createdAt: string
  /** URL-safe short-link slug, unique per user (lazily assigned from the title). */
  slug: string | null
  /** Continue Listening: last reported playback position in seconds. */
  positionSec: number | null
  /** When the position was last reported. */
  playedAt: string | null
}

/** Fields required to insert a new audio row (slug is assigned post-insert). */
export type NewAudio = Omit<AudioRecord, 'id' | 'createdAt' | 'slug' | 'positionSec' | 'playedAt'>

/** structuredContent payload for the player UI after text_to_speech. */
export type PlayerPayload = {
  kind: 'audio'
  id: string
  title: string
  audioUrl: string
  durationSec: number | null
  voice: string
  createdAt: string
  /** One-line synopsis, shown as the player subtitle. */
  summary: string | null
  /** Single emoji badge overlaid on the cover art. */
  emoji: string | null
  /** One-word mood tinting the generative cover. */
  mood: string | null
  /** True when the audio was served from storage instead of generated. */
  deduped: boolean
}

/** One item in the history list (no URL — presigned on demand). */
export type HistoryItem = {
  id: string
  title: string
  durationSec: number | null
  voice: string
  charCount: number
  createdAt: string
  status: AudioStatus
  /** One-line synopsis. */
  summary: string | null
  /** Single emoji badge overlaid on the cover thumbnail. */
  emoji: string | null
  /** One-word mood tinting the generative cover. */
  mood: string | null
}

/** structuredContent payload while a long generation runs in the background. */
export type ProcessingPayload = {
  kind: 'processing'
  id: string
  title: string
  charCount: number
  chunksDone: number
  chunksTotal: number
  createdAt: string
}

/** get_audio_status result: progress, terminal error, or the ready audio. */
export type StatusPayload = {
  kind: 'status'
  id: string
  status: AudioStatus
  chunksDone: number
  chunksTotal: number
  error: string | null
  /** Present iff status === 'ready'. */
  audio: PlayerPayload | null
}

/** structuredContent payload for the history view. */
export type HistoryPayload = {
  kind: 'history'
  items: HistoryItem[]
  total: number
}

/** structuredContent payload for the hidden vortex easter egg. */
export type VortexPayload = {
  kind: 'vortex'
  /** Seed for the vortex animation so each opening looks different. */
  seed: number
}
