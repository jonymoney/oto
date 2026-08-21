import express, { Router } from 'express'
import type { RequestHandler } from 'express'
import {
  audioRepo,
  usageRepo,
  prefsRepo,
  userRepo,
  followRepo,
  savedRepo,
  collectionRepo,
  connectionRepo,
  allowedVisibilities,
  VISIBILITIES,
} from './db.js'
import { VOICES, FISH_VOICES, providerForVoice } from './tts.js'
import { presignAudioUrl, presignAvatarUrl, putAvatar, deleteAudioObject } from './storage.js'
import { userIdFrom, authUserFrom } from './auth.js'
import { config } from './config.js'
import { createCheckoutSession, createPortalSession } from './billing.js'
import { previewsRouter } from './previews.js'
import { recommendationsFor } from './recs.js'
import { usernameFor, ensureSlug, shareUrlFor, RESERVED_USERNAMES } from './share.js'
import type { AudioRecord, Visibility } from './types.js'

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
    clientName: rec.clientName,
    charCount: rec.charCount,
    createdAt: rec.createdAt,
    status: rec.status,
    positionSec: rec.positionSec,
    playedAt: rec.playedAt,
    visibility: rec.visibility,
  }
}

const avatarUrl = (image: string | null) => (image ? presignAvatarUrl(image) : Promise.resolve(null))

// PUT /me contract: lowercase, 3–24 chars, alnum with inner hyphens.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])?$/
const usernameReason = (u: string): 'invalid' | 'reserved' | null => {
  if (u.length < 3 || u.length > 24 || !USERNAME_RE.test(u)) return 'invalid'
  if (RESERVED_USERNAMES.has(u)) return 'reserved'
  return null
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'

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
      // Own audios UNIONed with saved ones; owner: null = own, else the owner's
      // username. Usernames + slugs lazily backfilled — usernames cached per
      // owner, slugs sequential so same-title items can't race each other.
      const { items, total } = await audioRepo.listWithSaved(userId, limit, offset)
      const names = new Map<string, string>()
      const nameOf = async (uid: string) => {
        if (!names.has(uid)) names.set(uid, await usernameFor(uid))
        return names.get(uid)!
      }
      const out = []
      for (const rec of items) {
        const ownerName = await nameOf(rec.userId)
        out.push({
          ...listItem(rec),
          owner: rec.userId === userId ? null : ownerName,
          shareUrl: shareUrlFor(ownerName, await ensureSlug(rec)),
        })
      }
      res.json({ items: out, total })
    }),
  )

  // Own/saved rows resolve as before; any other id also resolves — the id is a
  // capability (the public /a/:id share page serves the same audio), so an authed
  // user browsing Explore/profiles can play without saving first.
  const byIdForViewer = async (userId: string, id: string) =>
    (await audioRepo.getById(userId, id)) ?? (await audioRepo.getByIdPublic(id))

  router.get(
    '/audios/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const rec = await byIdForViewer(userId, req.params.id)
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
      const rec = await byIdForViewer(userId, req.params.id)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      if (rec.status !== 'ready') return res.status(409).json({ error: `Audio is ${rec.status}` })
      // Anonymous aggregate play counter — fire-and-forget, never blocks the presign.
      if (rec.userId !== userId) void audioRepo.incrementPlays(rec.id).catch(() => {})
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
      if (!found) {
        // Position belongs to the owner's row — for a SAVED audio, no-op.
        if (await savedRepo.isSaved(userId, req.params.id)) return res.status(204).end()
        return res.status(404).json({ error: 'Not found' })
      }
      res.status(204).end()
    }),
  )

  router.delete(
    '/audios/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const rec = await audioRepo.deleteById(userId, req.params.id)
      if (!rec) {
        // Not the caller's own row: if it's one they SAVED, unsave instead of
        // deleting someone else's audio (iOS swipe-delete hits this path).
        if (await savedRepo.isSaved(userId, req.params.id)) {
          await savedRepo.unsave(userId, req.params.id)
          return res.status(204).end()
        }
        return res.status(404).json({ error: 'Not found' })
      }
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
      const { userId, email } = authUserFrom({ authInfo: req.auth })
      const [generatedSec, unlimited] = await Promise.all([
        usageRepo.generatedSec(userId, email),
        usageRepo.isUnlimited(userId),
      ])
      const quotaSec = config.QUOTA_MINUTES * 60
      const effectiveUnlimited = unlimited || quotaSec === 0
      res.json({
        generatedSec,
        quotaSec,
        unlimited: effectiveUnlimited,
        showUpgrade: config.billingEnabled && !effectiveUnlimited,
      })
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

  // ── Identity ──────────────────────────────────────────────────────────────

  const mePayload = async (user: { email: string; username: string | null; image: string | null }) => ({
    email: user.email,
    username: user.username, // null until derived/claimed — NOT lazily derived here
    avatarUrl: await avatarUrl(user.image),
  })

  router.get(
    '/me',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const user = await userRepo.get(userId)
      if (!user) return res.status(404).json({ error: 'Not found' })
      res.json(await mePayload(user))
    }),
  )

  router.put(
    '/me',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const { username } = (req.body ?? {}) as { username?: unknown }
      if (typeof username !== 'string') return res.status(400).json({ error: 'invalid' })
      const name = username.toLowerCase()
      const reason = usernameReason(name)
      if (reason) return res.status(400).json({ error: reason })
      try {
        await userRepo.setUsername(userId, name)
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ error: 'taken' })
        throw err
      }
      const user = await userRepo.get(userId)
      if (!user) return res.status(404).json({ error: 'Not found' })
      res.json(await mePayload(user))
    }),
  )

  router.get(
    '/me/username-available',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const name = String(req.query.u ?? '').toLowerCase()
      const reason = usernameReason(name)
      if (reason) return res.json({ available: false, reason })
      const owner = await userRepo.findByUsername(name)
      if (owner && owner.id !== userId) return res.json({ available: false, reason: 'taken' })
      res.json({ available: true })
    }),
  )

  router.put(
    '/me/avatar',
    express.raw({ type: 'image/*', limit: '5mb' }),
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Send the image bytes as the request body' })
      }
      const key = `avatars/${userId}.jpg`
      await putAvatar(key, req.body)
      await userRepo.setImage(userId, key)
      res.json({ avatarUrl: await presignAvatarUrl(key) })
    }),
  )

  // ── Visibility ────────────────────────────────────────────────────────────

  router.patch(
    '/audios/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const { visibility } = (req.body ?? {}) as { visibility?: unknown }
      if (typeof visibility !== 'string' || !VISIBILITIES.includes(visibility as Visibility)) {
        return res.status(400).json({ error: `visibility must be one of: ${VISIBILITIES.join(', ')}` })
      }
      const rec = await audioRepo.setVisibility(userId, req.params.id, visibility as Visibility)
      if (!rec) return res.status(404).json({ error: 'Not found' })
      res.json(await detail(rec))
    }),
  )

  // ── Saves ─────────────────────────────────────────────────────────────────

  // Save-by-id is allowed unconditionally (except own audios): the unguessable
  // id is itself a capability — anyone holding it can already play the audio
  // via its share link, so gating the save on visibility adds nothing.
  router.post(
    '/audios/:id/save',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const rec = await audioRepo.getByIdPublic(req.params.id)
      if (!rec || rec.status !== 'ready') return res.status(404).json({ error: 'Not found' })
      if (rec.userId === userId) return res.status(400).json({ error: 'Cannot save your own audio' })
      await savedRepo.save(userId, rec.id)
      res.status(204).end()
    }),
  )

  router.delete(
    '/audios/:id/save',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      await savedRepo.unsave(userId, req.params.id)
      res.status(204).end()
    }),
  )

  // ── People ────────────────────────────────────────────────────────────────

  router.get(
    '/users/search',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const users = await userRepo.search(String(req.query.q ?? ''), userId, 10)
      res.json({
        items: await Promise.all(
          users.map(async (u) => ({ username: u.username, avatarUrl: await avatarUrl(u.image) })),
        ),
      })
    }),
  )

  router.get(
    '/users/:username',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const target = await userRepo.findByUsername(req.params.username)
      if (!target) return res.status(404).json({ error: 'Not found' })
      const [audios, followCounts, rel] = await Promise.all([
        audioRepo.publicCount(target.id),
        followRepo.counts(target.id),
        followRepo.relation(userId, target.id),
      ])
      res.json({
        username: target.username,
        avatarUrl: await avatarUrl(target.image),
        counts: { audios, ...followCounts },
        youFollow: rel.viewerFollowsOwner,
        followsYou: rel.ownerFollowsViewer,
      })
    }),
  )

  router.put(
    '/users/:username/follow',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const target = await userRepo.findByUsername(req.params.username)
      if (!target) return res.status(404).json({ error: 'Not found' })
      if (target.id === userId) return res.status(400).json({ error: 'Cannot follow yourself' })
      await followRepo.follow(userId, target.id)
      res.status(204).end()
    }),
  )

  router.delete(
    '/users/:username/follow',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const target = await userRepo.findByUsername(req.params.username)
      if (!target) return res.status(404).json({ error: 'Not found' })
      if (target.id === userId) return res.status(400).json({ error: 'Cannot follow yourself' })
      await followRepo.unfollow(userId, target.id)
      res.status(204).end()
    }),
  )

  router.get(
    '/following',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const users = await followRepo.following(userId)
      res.json({
        items: await Promise.all(
          users.map(async (u) => ({ username: u.username, avatarUrl: await avatarUrl(u.image) })),
        ),
      })
    }),
  )

  router.get(
    '/users/:username/audios',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const target = await userRepo.findByUsername(req.params.username)
      if (!target) return res.status(404).json({ error: 'Not found' })
      // Relationship computed once; own profile sees everything incl. private.
      const vis =
        target.id === userId
          ? VISIBILITIES
          : await followRepo
              .relation(userId, target.id)
              .then((r) => allowedVisibilities(r.viewerFollowsOwner, r.ownerFollowsViewer))
      const recs = await audioRepo.listVisibleByUser(target.id, vis, 50, 0)
      const items = []
      for (const rec of recs) {
        items.push({
          ...listItem(rec),
          owner: target.username,
          shareUrl: shareUrlFor(target.username!, await ensureSlug(rec)),
        })
      }
      res.json({ items })
    }),
  )

  // Explore v2: follows shelf + recommendations + tags + recent. `items` stays
  // as an alias of `recent` so the shipped client keeps working.
  router.get(
    '/explore',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const [recent, follows, forYouAll, tags] = await Promise.all([
        audioRepo.listPublicRecent(userId, 30, 0),
        audioRepo.listFolloweesRecent(userId, 20),
        recommendationsFor(userId),
        audioRepo.topPublicTags(),
      ])
      // forYou hides what the follows shelf above already shows; recent stays
      // unfiltered. Hidden entirely when too thin or indistinguishable from recent.
      const followIds = new Set(follows.map((r) => r.id))
      let forYou = forYouAll.filter((r) => !followIds.has(r.id)).slice(0, 10)
      const top5 = (rs: Array<{ id: string }>) => rs.slice(0, 5).map((r) => r.id).join(',')
      if (forYou.length < 3 || top5(forYou) === top5(recent)) forYou = []
      // One ensureSlug per unique audio, sequential (slug collisions are per-user;
      // sequential is the safe rule — see ensureSlug's check-then-set fallback).
      const slugs = new Map<string, string>()
      for (const rec of [...follows, ...forYou, ...recent]) {
        if (!slugs.has(rec.id)) slugs.set(rec.id, await ensureSlug(rec))
      }
      const entry = (rec: AudioRecord & { ownerUsername: string }) => ({
        ...listItem(rec),
        owner: rec.ownerUsername,
        shareUrl: shareUrlFor(rec.ownerUsername, slugs.get(rec.id)!),
      })
      const recentOut = recent.map(entry)
      res.json({
        follows: follows.map(entry),
        forYou: forYou.map(entry),
        tags,
        recent: recentOut,
        items: recentOut,
      })
    }),
  )

  // Public audios carrying a tag (exact match, lowercased). Unknown tag = empty list.
  router.get(
    '/tags/:tag/audios',
    wrap(async (req, res) => {
      const recs = await audioRepo.listByTag(req.params.tag, 50)
      const items = []
      for (const rec of recs) {
        items.push({
          ...listItem(rec),
          owner: rec.ownerUsername,
          shareUrl: shareUrlFor(rec.ownerUsername, await ensureSlug(rec)),
        })
      }
      res.json({ items })
    }),
  )

  // ── Collections ───────────────────────────────────────────────────────────

  router.get(
    '/collections',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      // Every user gets a "Favorites" default collection, created on first list.
      await collectionRepo.ensureDefault(userId)
      res.json({ items: await collectionRepo.list(userId) })
    }),
  )

  router.post(
    '/collections',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const { name } = (req.body ?? {}) as { name?: unknown }
      const trimmed = typeof name === 'string' ? name.trim() : ''
      if (trimmed.length < 1 || trimmed.length > 60) {
        return res.status(400).json({ error: 'name must be 1–60 characters' })
      }
      const created = await collectionRepo.create(userId, trimmed)
      res.json({ ...created, isDefault: false, count: 0 })
    }),
  )

  router.delete(
    '/collections/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const outcome = await collectionRepo.delete(userId, req.params.id)
      if (outcome === 'default') {
        return res.status(400).json({ error: 'The default collection cannot be deleted' })
      }
      if (outcome === 'missing') return res.status(404).json({ error: 'Not found' })
      res.status(204).end()
    }),
  )

  router.put(
    '/collections/:id/items/:audioId',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      if (!(await collectionRepo.owns(userId, req.params.id))) {
        return res.status(404).json({ error: 'Not found' })
      }
      try {
        await collectionRepo.addItem(req.params.id, req.params.audioId)
      } catch {
        // FK violation — the audio doesn't exist.
        return res.status(404).json({ error: 'Audio not found' })
      }
      res.status(204).end()
    }),
  )

  router.delete(
    '/collections/:id/items/:audioId',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      if (!(await collectionRepo.owns(userId, req.params.id))) {
        return res.status(404).json({ error: 'Not found' })
      }
      await collectionRepo.removeItem(req.params.id, req.params.audioId)
      res.status(204).end()
    }),
  )

  router.get(
    '/collections/:id',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      const col = await collectionRepo.get(userId, req.params.id)
      if (!col) return res.status(404).json({ error: 'Not found' })
      const names = new Map<string, string>()
      const nameOf = async (uid: string) => {
        if (!names.has(uid)) names.set(uid, await usernameFor(uid))
        return names.get(uid)!
      }
      const items = []
      for (const rec of col.items) {
        items.push({
          ...listItem(rec),
          owner: rec.userId === userId ? null : await nameOf(rec.userId),
        })
      }
      res.json({ id: col.id, name: col.name, isDefault: col.isDefault, items })
    }),
  )

  // ── AI connections ────────────────────────────────────────────────────────

  // Mirrors clientDisplayName in mcp.ts (private there): dynamic client
  // registration names are often raw slugs — map the known ones to friendly names.
  const connectionName = (raw: string): string => {
    const l = raw.toLowerCase()
    if (l.includes('claude-code') || l.includes('claude code')) return 'Claude Code'
    if (l.includes('claude')) return 'Claude'
    if (l.includes('chatgpt') || l.includes('openai')) return 'ChatGPT'
    if (l.includes('cursor')) return 'Cursor'
    return raw.slice(0, 40)
  }

  // AI clients (Claude, ChatGPT, Cursor…) this user connected via OAuth.
  router.get(
    '/connections',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      // Clients like Claude register a fresh OAuth client per connection —
      // group by display name so the user sees one row per AI, not one per
      // registration. Disconnect revokes every clientId in the group.
      const groups = new Map<
        string,
        { clientId: string; clientIds: string[]; name: string; firstConnectedAt: string; lastUsedAt: string | null }
      >()
      for (const c of await connectionRepo.list(userId)) {
        const name = connectionName(c.name)
        const g = groups.get(name)
        if (!g) {
          groups.set(name, { ...c, name, clientIds: [c.clientId] })
        } else {
          g.clientIds.push(c.clientId)
          if (c.firstConnectedAt < g.firstConnectedAt) g.firstConnectedAt = c.firstConnectedAt
          if (c.lastUsedAt && (!g.lastUsedAt || c.lastUsedAt > g.lastUsedAt)) g.lastUsedAt = c.lastUsedAt
        }
      }
      res.json({ items: [...groups.values()] })
    }),
  )

  // Revoke a connected client: its refresh tokens die immediately (they live in
  // the deleted oauthAccessToken rows) and re-connecting requires consent again.
  // Opaque access tokens (the MCP connector path — validated by DB lookup in
  // auth.ts) also die immediately; a JWT-form access token verified statelessly
  // via JWKS keeps working until its exp — 1 hour after issue (Better Auth's
  // oidcProvider default, confirmed against prod accessTokenExpiresAt rows).
  router.delete(
    '/connections/:clientId',
    wrap(async (req, res) => {
      const userId = userIdFrom({ authInfo: req.auth })
      await connectionRepo.revoke(userId, req.params.clientId)
      res.status(204).end()
    }),
  )

  // ── Billing ───────────────────────────────────────────────────────────────

  // Stripe customer portal (manage/cancel the subscription).
  router.post(
    '/billing/portal',
    wrap(async (req, res) => {
      if (!config.billingEnabled) return res.status(501).json({ error: 'Billing not configured' })
      const userId = userIdFrom({ authInfo: req.auth })
      res.json({ url: await createPortalSession(userId) })
    }),
  )

  router.use(previewsRouter())

  return router
}
