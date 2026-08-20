import { Router } from 'express'
import type { RequestHandler } from 'express'
import { audioRepo, usageRepo, prefsRepo } from './db.js'
import { VOICES, FISH_VOICES, providerForVoice } from './tts.js'
import { presignAudioUrl, deleteAudioObject } from './storage.js'
import { userIdFrom, authUserFrom } from './auth.js'
import { config } from './config.js'
import { createCheckoutSession } from './billing.js'
import { previewsRouter } from './previews.js'
import { usernameFor, ensureSlug, shareUrlFor } from './share.js'
import type { AudioRecord } from './types.js'

// REST JSON API for native clients (iOS). Mounts behind the same
// authMiddleware() as /mcp, so req.auth carries the verified Better Auth user.
// Everything here reuses the existing data + storage layers — no new auth,
// no new persistence.

function listItem(rec: AudioRecord) {
  return {
    id: rec.id,
    title: rec.title,
    summary: rec.summary,
    emoji: rec.emoji,
    language: rec.language,
    mood: rec.mood,
    tags: rec.tags,
    durationSec: rec.durationSec,
    voice: rec.voice,
    charCount: rec.charCount,
    createdAt: rec.createdAt,
    status: rec.status,
    positionSec: rec.positionSec,
    playedAt: rec.playedAt,
  }
}

// Presign only when playable; a processing/error row has no object to serve yet.
async function detail(rec: AudioRecord) {
  return {
    ...listItem(rec),
    shareUrl: shareUrlFor(await usernameFor(rec.userId), await ensureSlug(rec)),
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
      // Lazily backfills username + slugs; username resolved once per request,
      // slugs sequentially so same-title items can't race each other.
      const username = items.length ? await usernameFor(userId) : null
      const out = []
      for (const rec of items) {
        out.push({ ...listItem(rec), shareUrl: shareUrlFor(username!, await ensureSlug(rec)) })
      }
      res.json({ items: out, total })
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

  // Continue Listening: the client reports the playback position (throttled).
  router.put(
    '/audios/:id/position',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const { positionSec } = (req.body ?? {}) as { positionSec?: unknown }
      if (typeof positionSec !== 'number' || !Number.isFinite(positionSec) || positionSec < 0) {
        return res.status(400).json({ error: 'positionSec must be a finite number >= 0' })
      }
      const found = await audioRepo.setPosition(userId, req.params.id, positionSec)
      if (!found) return res.status(404).json({ error: 'Not found' })
      res.status(204).end()
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

  // Generation quota for the app's usage meter. quotaSec 0 = unlimited for all.
  router.get(
    '/usage',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const [generatedSec, unlimited] = await Promise.all([
        usageRepo.generatedSec(userId),
        usageRepo.isUnlimited(userId),
      ])
      const quotaSec = config.QUOTA_MINUTES * 60
      res.json({ generatedSec, quotaSec, unlimited: unlimited || quotaSec === 0 })
    }),
  )

  // Per-user generation preferences. null = server default; the allowed lists
  // let the client render its pickers without hardcoding them. The provider is
  // implied by the chosen voice, so there is no separate provider choice.
  const voiceNames = () => [...VOICES, ...(config.fishEnabled ? Object.keys(FISH_VOICES) : [])]
  // BCP-47 primary tags; the client renders localized display names.
  const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'hi']
  const prefsPayload = (prefs: {
    voice: string | null
    provider: string | null
    language: string | null
  }) => ({
    ...prefs,
    voices: voiceNames().map((name) => ({ name, provider: providerForVoice(name) })),
    languages: LANGUAGES,
  })

  router.get(
    '/prefs',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      res.json(prefsPayload(await prefsRepo.get(userId)))
    }),
  )

  router.put(
    '/prefs',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const { voice, language } = (req.body ?? {}) as { voice?: unknown; language?: unknown }
      if (voice !== undefined && (typeof voice !== 'string' || !voiceNames().includes(voice))) {
        return res.status(400).json({ error: `voice must be one of: ${voiceNames().join(', ')}` })
      }
      if (language !== undefined && (typeof language !== 'string' || !LANGUAGES.includes(language))) {
        return res.status(400).json({ error: `language must be one of: ${LANGUAGES.join(', ')}` })
      }
      // Picking a voice pins its provider too, keeping older rows consistent.
      const provider = voice !== undefined ? providerForVoice(voice as string) : undefined
      res.json(prefsPayload(await prefsRepo.set(userId, { voice, provider, language })))
    }),
  )

  // Start a Stripe Checkout for the "unlimited" subscription. 501 until billing
  // is configured. Returns the hosted Checkout URL for the client to redirect to.
  router.post(
    '/billing/checkout',
    wrap(async (req, res) => {
      if (!config.billingEnabled) return res.status(501).json({ error: 'Billing not configured' })
      const { userId, email } = authUserFrom({ authInfo: req.auth })
      const url = await createCheckoutSession(userId, email)
      res.json({ url })
    }),
  )

  router.use(previewsRouter())

  return router
}
