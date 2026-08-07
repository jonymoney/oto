import { Router } from 'express'
import type { RequestHandler } from 'express'
import { audioRepo } from './db.js'
import { presignAudioUrl, deleteAudioObject } from './storage.js'
import { userIdFrom } from './auth.js'
import { config } from './config.js'
import type { AudioRecord } from './types.js'

// REST JSON API for native clients (iOS). Mounts behind the same
// authMiddleware() as /mcp, so req.auth carries the verified Better Auth user.
// Everything here reuses the existing data + storage layers — no new auth,
// no new persistence.

function listItem(rec: AudioRecord) {
  return {
    id: rec.id,
    title: rec.title,
    durationSec: rec.durationSec,
    voice: rec.voice,
    charCount: rec.charCount,
    createdAt: rec.createdAt,
    status: rec.status,
  }
}

// Presign only when playable; a processing/error row has no object to serve yet.
async function detail(rec: AudioRecord) {
  return {
    ...listItem(rec),
    audioUrl: rec.status === 'ready' ? await presignAudioUrl(rec.objectKey) : null,
  }
}

// Express 4 swallows async throws — wrap so rejections hit the error handler.
const wrap =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next)

export function apiRouter(): Router {
  const router = Router()

  router.get(
    '/audios',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const limit = Number(req.query.limit ?? 50)
      const offset = Number(req.query.offset ?? 0)
      const { items, total } = await audioRepo.listByUser(userId, limit, offset)
      res.json({ items: items.map(listItem), total })
    }),
  )

  router.get(
    '/audios/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const rec = await audioRepo.getById(userId, req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      // Flip a dead 'processing' row to 'error' before reporting.
      res.json(await detail(await audioRepo.resolveStale(rec)))
    }),
  )

  // Presigned URLs expire; the client refetches one here without reloading the row.
  router.get(
    '/audios/:id/url',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const rec = await audioRepo.getById(userId, req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      if (rec.status !== 'ready') return res.status(409).json({ error: `Audio is ${rec.status}` })
      res.json({ audioUrl: await presignAudioUrl(rec.objectKey), expiresIn: config.AUDIO_URL_TTL_SECONDS })
    }),
  )

  router.delete(
    '/audios/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const rec = await audioRepo.deleteById(userId, req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      try {
        await deleteAudioObject(rec.objectKey)
      } catch (err) {
        // Row is gone; a leftover object is harmless (janitor/dedup tolerate it).
        console.error(`Failed to delete bucket object ${rec.objectKey}:`, err)
      }
      res.status(204).end()
    }),
  )

  return router
}
