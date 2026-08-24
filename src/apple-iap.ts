// Apple In-App Purchase rail — the non-US counterpart of billing.ts (Stripe).
// Two entry points, same shape as the Stripe webhook:
//   - POST /billing/apple/notifications  App Store Server Notifications v2
//     (public, JWS-verified — Apple's signature IS the auth)
//   - POST /api/billing/apple/sync       the app reports its own transaction
//     right after purchase/restore (Bearer-authed), which also maps the
//     originalTransactionId -> user for future notifications.
// Both converge on applyTransaction(), which flips the same `unlimited` flag
// Stripe uses.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { SignedDataVerifier, Environment } from '@apple/app-store-server-library'
import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library'
import { pool, usageRepo } from './db.js'
import { userIdFrom } from './auth.js'
import { config } from './config.js'

const BUNDLE_ID = 'audio.oto.app'

const CERTS_DIR = path.join(process.cwd(), 'certs', 'apple')
const CERT_FILES = [
  'AppleIncRootCertificate.cer',
  'AppleComputerRootCertificate.cer',
  'AppleRootCA-G2.cer',
  'AppleRootCA-G3.cer',
]

// Sandbox always (TestFlight and App Review purchases are sandbox-signed);
// production only once APPLE_APP_APPLE_ID exists (assigned by App Store
// Connect when the app record is created). A JWS is tried against each.
let verifiers: SignedDataVerifier[] | null = null
function getVerifiers(): SignedDataVerifier[] {
  if (verifiers) return verifiers
  const roots = CERT_FILES.map((f) => readFileSync(path.join(CERTS_DIR, f)))
  verifiers = [new SignedDataVerifier(roots, true, Environment.SANDBOX, BUNDLE_ID)]
  if (config.APPLE_APP_APPLE_ID) {
    verifiers.push(
      new SignedDataVerifier(roots, true, Environment.PRODUCTION, BUNDLE_ID, config.APPLE_APP_APPLE_ID),
    )
  }
  return verifiers
}

async function verifyTransaction(jws: string): Promise<JWSTransactionDecodedPayload | null> {
  for (const v of getVerifiers()) {
    try {
      return await v.verifyAndDecodeTransaction(jws)
    } catch {
      // wrong environment or bad signature — try the next verifier
    }
  }
  return null
}

// Own table, own ensure — keeps db.ts untouched (billing.ts precedent: leaf
// modules run their own targeted queries against the shared pool).
let schemaReady: Promise<void> | null = null
function ensureSchema(): Promise<void> {
  schemaReady ??= pool
    .query(
      `create table if not exists apple_subscriptions (
         original_transaction_id text primary key,
         user_id uuid not null,
         product_id text not null,
         status text not null,
         expires_at timestamptz,
         updated_at timestamptz not null default now()
       )`,
    )
    .then(() => undefined)
  return schemaReady
}

const isActive = (tx: JWSTransactionDecodedPayload): boolean =>
  !tx.revocationDate && (tx.expiresDate ?? 0) > Date.now()

/**
 * Record a verified transaction and update the user's entitlement.
 * userId null = notification path: resolve the user from a prior sync's
 * mapping; unknown ids are dropped (the app's sync will map them).
 * Returns whether the subscription is currently active.
 */
async function applyTransaction(
  userId: string | null,
  tx: JWSTransactionDecodedPayload,
): Promise<{ applied: boolean; active: boolean }> {
  const otid = tx.originalTransactionId
  if (!otid || tx.productId !== config.APPLE_PRODUCT_ID) return { applied: false, active: false }
  await ensureSchema()

  if (userId === null) {
    const { rows } = await pool.query<{ user_id: string }>(
      'select user_id from apple_subscriptions where original_transaction_id = $1',
      [otid],
    )
    userId = rows[0]?.user_id ?? null
    if (!userId) return { applied: false, active: false }
  }

  const active = isActive(tx)
  const status = tx.revocationDate ? 'revoked' : active ? 'active' : 'expired'
  await pool.query(
    `insert into apple_subscriptions (original_transaction_id, user_id, product_id, status, expires_at, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (original_transaction_id)
     do update set user_id = $2, status = $4, expires_at = $5, updated_at = now()`,
    [otid, userId, tx.productId, status, tx.expiresDate ? new Date(tx.expiresDate) : null],
  )

  if (active) {
    await usageRepo.setUnlimited(userId, true)
  } else {
    // Don't clobber an active Stripe subscription on Apple expiry.
    // ponytail: the symmetric guard (Stripe expiry checking Apple) is skipped —
    // nobody realistically holds both rails; add it if support tickets say so.
    const { rows } = await pool.query<{ subscription_status: string | null }>(
      'select subscription_status from usage_counters where user_id = $1',
      [userId],
    )
    const stripePaid = rows[0]?.subscription_status === 'active' || rows[0]?.subscription_status === 'trialing'
    if (!stripePaid) await usageRepo.setUnlimited(userId, false)
  }
  return { applied: true, active }
}

/** App Store Server Notifications v2 — mount at /billing/apple/notifications. */
export function appleWebhookRouter(): Router {
  const router = Router()
  router.post('/billing/apple/notifications', async (req, res) => {
    const signedPayload = (req.body as { signedPayload?: unknown } | undefined)?.signedPayload
    if (typeof signedPayload !== 'string') return res.status(400).json({ error: 'Bad payload' })

    let signedTransactionInfo: string | undefined
    for (const v of getVerifiers()) {
      try {
        signedTransactionInfo = (await v.verifyAndDecodeNotification(signedPayload)).data
          ?.signedTransactionInfo
        break
      } catch {
        // try next environment
      }
    }
    if (signedTransactionInfo === undefined) {
      // Not verifiable in any configured environment: reject so a genuine
      // misconfiguration surfaces in Apple's delivery logs.
      return res.status(401).json({ error: 'Verification failed' })
    }
    if (signedTransactionInfo) {
      const tx = await verifyTransaction(signedTransactionInfo)
      // Unknown user/product is a 200: Apple retries on non-2xx, and the
      // mapping arrives with the app's own sync — renewals re-deliver monthly.
      if (tx) await applyTransaction(null, tx).catch((err) => console.error('apple iap apply:', err))
    }
    res.status(200).end()
  })
  return router
}

/** Authed transaction sync — mount under /api (Bearer) at /billing/apple/sync. */
export function appleSyncRouter(): Router {
  const router = Router()
  router.post('/billing/apple/sync', async (req, res, next) => {
    try {
      const userId = userIdFrom({ authInfo: req.auth })
      const jws = (req.body as { jws?: unknown } | undefined)?.jws
      if (typeof jws !== 'string') return res.status(400).json({ error: 'jws (string) required' })
      const tx = await verifyTransaction(jws)
      if (!tx) return res.status(400).json({ error: 'Transaction verification failed' })
      const { applied, active } = await applyTransaction(userId, tx)
      if (!applied) return res.status(400).json({ error: 'Unknown product' })
      res.json({ unlimited: active })
    } catch (err) {
      next(err)
    }
  })
  return router
}
