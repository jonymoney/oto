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
export type PlayerPayload = {
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
export type HistoryItem = {
  id: string
  title: string
  durationSec: number | null
  voice: string
  charCount: number
  createdAt: string
  status: AudioStatus
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

/** One voice with its playable, pre-generated sample. */
export type VoiceSample = {
  voice: string
  /** Presigned URL of the global sample mp3 (samples/<voice>.mp3). */
  sampleUrl: string
}

/** structuredContent payload for the voice gallery view. */
export type VoicesPayload = {
  kind: 'voices'
  voices: VoiceSample[]
  /** The user's current favorite voice, if any. */
  favorite: string | null
}

/** structuredContent payload for the hidden vortex easter egg. */
export type VortexPayload = {
  kind: 'vortex'
  /** Seed for the vortex animation so each opening looks different. */
  seed: number
}
