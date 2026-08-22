import { audioRepo, usageRepo } from './db.js'
import { putAudio } from './storage.js'
import { estimateSec, synthesizeChunked } from './tts.js'
import type { TtsProvider } from './tts.js'

interface GenerationJobArgs {
  recId: string
  userId: string
  email?: string
  text: string
  voice: string
  instructions?: string
  provider?: TtsProvider
  /** Bucket key of the 'processing' row — the finished mp3 lands here. */
  objectKey: string
}

/** recId → in-flight job, so a shutdown can wait on (and then account for) them. */
const inFlight = new Map<string, Promise<void>>()

/**
 * Fire-and-forget background generation for a row already inserted with
 * status 'processing'. Never throws: any failure marks the row 'error', and
 * the trailing .catch guards even the error-marking path.
 */
export function startGenerationJob(args: GenerationJobArgs): void {
  const job = runGenerationJob(args)
    .catch((err) => {
      console.error(`Generation job ${args.recId} failed outside its own handler:`, err)
    })
    .finally(() => {
      inFlight.delete(args.recId)
    })
  inFlight.set(args.recId, job)
}

/**
 * Shutdown handling for background generation. Railway SIGTERMs on every
 * redeploy, and a job can outlive the grace period — so wait briefly, then mark
 * whatever is still running as failed. Without this the row stays 'processing'
 * until someone reopens it and the lazy janitor trips 15 minutes later; the user
 * meanwhile sees an audio that never finishes.
 */
export async function drainGenerationJobs(waitMs: number): Promise<void> {
  if (inFlight.size === 0) return
  console.log(`Draining ${inFlight.size} generation job(s), up to ${waitMs}ms…`)
  await Promise.race([
    Promise.allSettled([...inFlight.values()]),
    new Promise((resolve) => setTimeout(resolve, waitMs).unref()),
  ])
  const abandoned = [...inFlight.keys()]
  if (abandoned.length === 0) return
  console.log(`Abandoning ${abandoned.length} unfinished generation job(s): ${abandoned.join(', ')}`)
  await Promise.allSettled(
    abandoned.map((recId) =>
      audioRepo.markError(recId, 'Generation was interrupted by a server restart — try again.'),
    ),
  )
}

async function runGenerationJob(args: GenerationJobArgs): Promise<void> {
  const { recId, userId, email, text, voice, instructions, provider, objectKey } = args
  console.log(`Generation job ${recId} started (${text.length} chars)`)
  try {
    const result = await synthesizeChunked(text, {
      voice,
      instructions,
      provider,
      onChunkDone: () => {
        // Progress is best-effort: a lost increment only understates the bar.
        void audioRepo.markChunkDone(recId).catch((err) => {
          console.error(`Generation job ${recId} failed to record chunk progress:`, err)
        })
      },
    })
    await putAudio(objectKey, result.audio)
    await audioRepo.markReady(recId, result.durationSec)
    const generatedSec = result.durationSec ?? estimateSec(result.charCount)
    await usageRepo.addGeneratedSec(userId, generatedSec, email)
    console.log(`Generation job ${recId} finished (${generatedSec.toFixed(1)} sec of audio)`)
  } catch (err) {
    console.error(`Generation job ${recId} failed:`, err)
    await audioRepo.markError(recId, err instanceof Error ? err.message : String(err))
  }
}
