import { config } from './config.js'
import { audioObjectExists, presignAudioUrl, putAudio } from './storage.js'
import { synthesize, VOICES } from './tts.js'
import type { VoiceSample } from './types.js'

// Global voice samples: one bucket object per voice (samples/<voice>.mp3),
// lazily provisioned the first time the gallery is requested. They are shared
// by all users — no audios row, no usage charge, not part of anyone's history.

function sampleKey(voice: string): string {
  return `samples/${voice}.mp3`
}

// FIXED sample text — it must never vary, so the bucket objects are generated
// once ever and every later gallery request just replays the stored mp3s.
function sampleText(voice: string): string {
  const name = voice.charAt(0).toUpperCase() + voice.slice(1)
  return `Hi, I'm ${name}. This is how oto sounds with my voice.`
}

// In-flight guard: concurrent gallery requests within this process share one
// provisioning pass instead of double-generating. Across replicas a duplicate
// generation is still possible, but harmless — both write the same key, so the
// overwrite is idempotent.
let provisionPromise: Promise<void> | null = null
let provisioned = false

async function ensureSamplesProvisioned(): Promise<void> {
  if (provisioned) return
  if (!provisionPromise) {
    provisionPromise = provisionMissingSamples().then(
      () => {
        provisioned = true
      },
      (err) => {
        // Reset so the next gallery request retries instead of caching the failure.
        provisionPromise = null
        throw err
      },
    )
  }
  return provisionPromise
}

async function provisionMissingSamples(): Promise<void> {
  const exists = await Promise.all(VOICES.map((voice) => audioObjectExists(sampleKey(voice))))
  const missing = VOICES.filter((_, i) => !exists[i])
  if (missing.length === 0) return
  await Promise.all(
    missing.map(async (voice) => {
      const result = await synthesize(sampleText(voice), { voice })
      await putAudio(sampleKey(voice), result.audio)
    }),
  )
  console.log(`Provisioned ${missing.length} voice sample(s): ${missing.join(', ')}`)
}

// Presigned URLs are cached well inside their TTL (80%) so a gallery served
// from cache never hands out a URL about to expire mid-listen.
const URL_CACHE_MS = config.AUDIO_URL_TTL_SECONDS * 1000 * 0.8
let urlCache: { samples: VoiceSample[]; expiresAt: number } | null = null

/** All voices with playable sample URLs, provisioning the global mp3s on first use. */
export async function getVoiceSamples(): Promise<VoiceSample[]> {
  await ensureSamplesProvisioned()
  if (urlCache && Date.now() < urlCache.expiresAt) return urlCache.samples
  const samples = await Promise.all(
    VOICES.map(async (voice) => ({
      voice,
      sampleUrl: await presignAudioUrl(sampleKey(voice)),
    })),
  )
  urlCache = { samples, expiresAt: Date.now() + URL_CACHE_MS }
  return samples
}
