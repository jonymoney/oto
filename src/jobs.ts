import { audioRepo, usageRepo } from './db.js'
import { putAudio } from './storage.js'
import { estimateSec, synthesizeChunked } from './tts.js'

interface GenerationJobArgs {
  recId: string
  userId: string
  email?: string
  text: string
  voice: string
  instructions?: string
  /** Bucket key of the 'processing' row — the finished mp3 lands here. */
  objectKey: string
}

/**
 * Fire-and-forget background generation for a row already inserted with
 * status 'processing'. Never throws: any failure marks the row 'error', and
 * the trailing .catch guards even the error-marking path.
 */
export function startGenerationJob(args: GenerationJobArgs): void {
  void runGenerationJob(args).catch((err) => {
    console.error(`Generation job ${args.recId} failed outside its own handler:`, err)
  })
}

async function runGenerationJob(args: GenerationJobArgs): Promise<void> {
  const { recId, userId, email, text, voice, instructions, objectKey } = args
  console.log(`Generation job ${recId} started (${text.length} chars)`)
  try {
    const result = await synthesizeChunked(text, {
      voice,
      instructions,
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
