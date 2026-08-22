import OpenAI from 'openai'
import { parseBuffer } from 'music-metadata'
import { config } from './config.js'

/** The 13 built-in gpt-4o-mini-tts voices. */
export const VOICES: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]

/** Fish Audio marketplace voices: picker name → reference id. */
export const FISH_VOICES: Record<string, string> = {
  sarah: '933563129e564b19a115bedd57b7406a', // soft, breathy, sincere
  ethan: '536d3a5e000945adb7038665781a4aca', // calm documentary narrator
  adrian: 'bf322df2096a46f18c579d0baa36f41d', // deep, slow, dramatic storyteller
  jasphina: 'e9b134e4c0b547a3894793be502314f1', // playful, animated, fast
  blaze: '802e3bc2b27e49c2995d23ef70e6ac89', // bright, energetic announcer
  grim: 'ef9c79b62ef34530bf452c0e50e3c260', // low, mysterious horror narrator
}

/** The provider is implied by the voice name — there is no separate provider choice. */
export function providerForVoice(voice?: string | null): TtsProvider {
  return voice && FISH_VOICES[voice.trim().toLowerCase()] ? 'fish' : 'openai'
}

export function resolveVoice(voice?: string): string {
  if (voice) {
    const normalized = voice.trim().toLowerCase()
    const match = VOICES.find((v) => v === normalized)
    if (match) return match
    if (FISH_VOICES[normalized]) return normalized
  }
  return config.TTS_VOICE
}

// Split after sentence-ending punctuation (plus closing quotes/brackets) followed
// by whitespace, or after any newline — so chunk boundaries land on sentence or
// paragraph ends, never mid-word.
const SEGMENT_BOUNDARY = /(?<=[.!?…]["')\]]*\s)|(?<=\n)/
const WORD_BOUNDARY = /(?<=\s)/

/**
 * Splits text into chunks of at most `maxChars`, breaking on paragraph/sentence
 * boundaries (falling back to word boundaries, then hard splits for unbroken runs).
 * Default 3800 keeps each request under the API's 4096-char and ~2000-token limits.
 */
export function chunkText(text: string, maxChars = 3800): string[] {
  if (maxChars < 1) throw new Error('maxChars must be at least 1')
  const input = text.trim()
  if (!input) return []

  const chunks: string[] = []
  let current = ''

  const flush = (): void => {
    const chunk = current.trim()
    if (chunk) chunks.push(chunk)
    current = ''
  }

  const append = (piece: string): void => {
    if (current.length + piece.length > maxChars) flush()
    current += piece
  }

  for (const segment of input.split(SEGMENT_BOUNDARY)) {
    if (segment.length <= maxChars) {
      append(segment)
      continue
    }
    for (const word of segment.split(WORD_BOUNDARY)) {
      if (word.length <= maxChars) {
        append(word)
        continue
      }
      // Pathological unbroken run longer than maxChars: hard-split.
      flush()
      for (let i = 0; i < word.length; i += maxChars) {
        append(word.slice(i, i + maxChars))
      }
    }
  }
  flush()
  return chunks
}

/** ~15 chars/sec of speech — fallback when the mp3 duration probe fails. */
export function estimateSec(charCount: number): number {
  return charCount / 15
}

export interface SynthesisResult {
  audio: Buffer
  durationSec: number | null
  charCount: number
  model: string
  voice: string
  format: 'mp3'
}

// A TTS chunk is at most 3800 chars — ~30s of work. The SDK's stock 10-minute
// timeout (times 3 attempts) would pin a wedged upstream call for half an hour,
// long past the point the caller and the 15-minute stale-row janitor gave up.
const TTS_TIMEOUT_MS = 90_000

// Reads OPENAI_API_KEY from env; config.ts (imported above) has already loaded dotenv.
const openai = new OpenAI({ timeout: TTS_TIMEOUT_MS, maxRetries: 2 })

// Chunks synthesize concurrently, but capped: a 50k-char text is ~14 chunks, and
// several jobs can overlap. An uncapped fan-out invites provider 429s, which cost
// retries and wall-clock — 4 in flight keeps a long job fast without stampeding.
const MAX_CONCURRENT_CHUNKS = 4

/** Promise.all with a concurrency cap; results keep input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// The `instructions` param is rejected by the legacy tts-1 models.
const MODELS_WITHOUT_INSTRUCTIONS = new Set(['tts-1', 'tts-1-hd'])

export type TtsProvider = 'openai' | 'fish'

export async function synthesize(
  text: string,
  opts?: { voice?: string; instructions?: string; provider?: TtsProvider },
): Promise<SynthesisResult> {
  return synthesizeAll(text, opts ?? {})
}

/**
 * Like synthesize(), but reports progress: onChunkDone fires as each parallel
 * OpenAI chunk settles, with the count of finished chunks and the total.
 */
export async function synthesizeChunked(
  text: string,
  opts: {
    voice?: string
    instructions?: string
    provider?: TtsProvider
    onChunkDone?: (done: number, total: number) => void
  },
): Promise<SynthesisResult> {
  return synthesizeAll(text, opts)
}

async function synthesizeAll(
  text: string,
  opts: {
    voice?: string
    instructions?: string
    provider?: TtsProvider
    onChunkDone?: (done: number, total: number) => void
  },
): Promise<SynthesisResult> {
  const input = text.trim()
  if (!input) throw new Error('Cannot synthesize speech from empty text')

  // A Fish catalog voice name implies fish; otherwise the explicit/global provider.
  const requested = opts.voice?.trim().toLowerCase()
  const fishRef = requested ? FISH_VOICES[requested] : undefined
  const fish = fishRef !== undefined || (opts.provider ?? config.TTS_PROVIDER) === 'fish'
  const model = fish ? config.FISH_MODEL : config.TTS_MODEL
  // Keep the friendly name in results/history; the reference id only goes to the API.
  const voice = fish ? (fishRef ? requested! : 'fish') : resolveVoice(opts.voice)
  const referenceId = fishRef ?? config.FISH_REFERENCE_ID
  const instructions = opts.instructions?.trim()
  const withInstructions = !fish && instructions && !MODELS_WITHOUT_INSTRUCTIONS.has(model)

  const chunks = chunkText(input)
  let done = 0

  // Chunks synthesize concurrently (order preserved by mapWithLimit) — on the
  // sync path the host gets zero bytes until the JSON response is complete, so
  // wall-clock latency must stay well under client/edge timeouts.
  // Probe duration per chunk and sum: probing the concatenated buffer would report
  // only the first segment's length if it carries a Xing/LAME header.
  const parts = await mapWithLimit(chunks, MAX_CONCURRENT_CHUNKS, async (chunk) => {
    const buffer = fish
      ? await fishSynthChunk(chunk, referenceId)
      : await openaiSynthChunk(chunk, {
          model,
          voice,
          ...(withInstructions ? { instructions } : {}),
        })
    const part = { buffer, duration: await probeDurationSec(buffer) }
    done += 1
    opts.onChunkDone?.(done, chunks.length)
    return part
  })

  const buffers = parts.map((p) => p.buffer)
  let durationSec: number | null = 0
  for (const part of parts) {
    if (durationSec === null) break
    durationSec = part.duration === null ? null : durationSec + part.duration
  }

  // Naive byte concatenation of mp3 segments: players decode frame-by-frame, so
  // back-to-back streams play fine; only per-segment metadata is redundant.
  const audio = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers)

  return {
    audio,
    durationSec: durationSec === null ? null : Math.round(durationSec * 1000) / 1000,
    charCount: input.length,
    model,
    voice,
    format: 'mp3',
  }
}

async function openaiSynthChunk(
  chunk: string,
  opts: { model: string; voice: string; instructions?: string },
): Promise<Buffer> {
  const response = await openai.audio.speech.create({
    model: opts.model,
    voice: opts.voice,
    input: chunk,
    response_format: 'mp3',
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  })
  return Buffer.from(await response.arrayBuffer())
}

// Fish selects the model via an HTTP header named `model`; the voice is `reference_id`.
async function fishSynthChunk(chunk: string, referenceId?: string): Promise<Buffer> {
  if (!config.FISH_API_KEY) throw new Error('Fish Audio voice requested but FISH_API_KEY is not set')
  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.FISH_API_KEY}`,
      'Content-Type': 'application/json',
      model: config.FISH_MODEL,
    },
    body: JSON.stringify({
      text: chunk,
      format: 'mp3',
      mp3_bitrate: 128,
      ...(referenceId ? { reference_id: referenceId } : {}),
    }),
    // Bare fetch has no timeout of its own; without this a wedged Fish call
    // hangs the job forever. The OpenAI SDK applies TTS_TIMEOUT_MS itself.
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Fish Audio TTS failed (${response.status}): ${detail}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function probeDurationSec(audio: Buffer): Promise<number | null> {
  try {
    const metadata = await parseBuffer(
      audio,
      { mimeType: 'audio/mpeg', size: audio.length },
      { duration: true },
    )
    const duration = metadata.format.duration
    return typeof duration === 'number' && Number.isFinite(duration) ? duration : null
  } catch {
    return null
  }
}
