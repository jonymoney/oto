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

export function resolveVoice(voice?: string): string {
  if (voice) {
    const normalized = voice.trim().toLowerCase()
    const match = VOICES.find((v) => v === normalized)
    if (match) return match
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

export interface SynthesisResult {
  audio: Buffer
  durationSec: number | null
  charCount: number
  model: string
  voice: string
  format: 'mp3'
}

// Reads OPENAI_API_KEY from env; config.ts (imported above) has already loaded dotenv.
const openai = new OpenAI()

// The `instructions` param is rejected by the legacy tts-1 models.
const MODELS_WITHOUT_INSTRUCTIONS = new Set(['tts-1', 'tts-1-hd'])

export async function synthesize(
  text: string,
  opts?: { voice?: string; instructions?: string },
): Promise<SynthesisResult> {
  const input = text.trim()
  if (!input) throw new Error('Cannot synthesize speech from empty text')

  const model = config.TTS_MODEL
  const voice = resolveVoice(opts?.voice)
  const instructions = opts?.instructions?.trim()
  const withInstructions = instructions && !MODELS_WITHOUT_INSTRUCTIONS.has(model)

  const buffers: Buffer[] = []
  // Probe duration per chunk and sum: probing the concatenated buffer would report
  // only the first segment's length if it carries a Xing/LAME header.
  let durationSec: number | null = 0
  for (const chunk of chunkText(input)) {
    const response = await openai.audio.speech.create({
      model,
      voice,
      input: chunk,
      response_format: 'mp3',
      ...(withInstructions ? { instructions } : {}),
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    buffers.push(buffer)
    if (durationSec !== null) {
      const chunkDuration = await probeDurationSec(buffer)
      durationSec = chunkDuration === null ? null : durationSec + chunkDuration
    }
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
