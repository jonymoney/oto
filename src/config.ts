import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  // Canonical public URL of the MCP endpoint — the OAuth "resource" identifier.
  MCP_SERVER_URL: z.string().url(),

  OPENAI_API_KEY: z.string().min(1),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('coral'),
  TTS_FORMAT: z.literal('mp3').default('mp3'),
  // TTS provider switch — 'openai' (default) or 'fish' (Fish Audio). Flip to
  // 'fish' to ear-test Spanish/English/mixed against gpt-4o-mini-tts.
  TTS_PROVIDER: z.enum(['openai', 'fish']).default('openai'),
  // Fish Audio (https://fish.audio) — required only when TTS_PROVIDER=fish.
  FISH_API_KEY: z.string().optional(),
  FISH_MODEL: z.string().default('s2.1-pro'),
  // Optional Fish voice/reference model id; falls back to the model default.
  FISH_REFERENCE_ID: z.string().optional(),

  // Numeric App Store ID — set after App Store launch to light up the Smart
  // App Banner on share/profile pages. Unset = no banner.
  APP_STORE_ID: z.string().optional(),

  // ── Better Auth (self-hosted authorization server) ──────────────────────
  // Public origin of this service — Better Auth's baseURL and JWT issuer.
  BETTER_AUTH_URL: z.string().url(),
  // Signing secret for sessions/tokens. Generate: openssl rand -base64 32
  BETTER_AUTH_SECRET: z.string().min(1),
  // Comma-separated extra origins allowed to call the auth handler (app schemes,
  // web callback host). MCP_SERVER_URL/BETTER_AUTH_URL origins are added below.
  AUTH_TRUSTED_ORIGINS: z.string().default(''),

  // Email (Resend) — optional in dev; senders no-op without it.
  RESEND_API_KEY: z.string().optional(),
  AUTH_EMAIL_FROM: z.string().default('oto <auth@oto.app>'),
  // Web handoff page the magic-link email points at; it deep-links the token to
  // the iOS app so email-client previews don't burn the single-use token.
  AUTH_WEB_CALLBACK_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1),

  BUCKET_NAME: z.string().min(1),
  BUCKET_ENDPOINT: z.string().url().default('https://storage.railway.app'),
  BUCKET_REGION: z.string().default('auto'),
  BUCKET_ACCESS_KEY_ID: z.string().min(1),
  BUCKET_SECRET_ACCESS_KEY: z.string().min(1),
  AUDIO_URL_TTL_SECONDS: z.coerce.number().default(3600),

  // 'disabled' skips OAuth for local development only — never in production.
  AUTH_MODE: z.enum(['oauth', 'disabled']).default('oauth'),

  // Per-user cap on cumulative GENERATED audio (dedup replays are free and
  // deletions never refund). 0 = unlimited for everyone.
  QUOTA_MINUTES: z.coerce.number().min(0).default(10),
  // Comma-separated emails exempt from the quota. The per-user `unlimited`
  // flag in usage_counters does the same without a redeploy.
  QUOTA_EXEMPT_EMAILS: z.string().default(''),
  // Where the "generation limit reached" upsell points (web Stripe checkout).
  UPGRADE_URL: z.string().url().default('https://oto.audio/upgrade'),

  // ── Billing (Stripe) — optional; billing routes 501 until all three are set ──
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Price id of the recurring "oto unlimited" subscription product.
  STRIPE_PRICE_ID: z.string().optional(),
})

const env = EnvSchema.parse(process.env)

// Refuse to boot with auth disabled on Railway: one stray env var must never
// silently expose every tool (and the dev user's data) to the open internet.
if (env.AUTH_MODE === 'disabled' && process.env.RAILWAY_ENVIRONMENT) {
  throw new Error('AUTH_MODE=disabled is forbidden in Railway environments — unset it or use "oauth"')
}

const trustedOrigins = Array.from(
  new Set(
    [
      new URL(env.BETTER_AUTH_URL).origin,
      new URL(env.MCP_SERVER_URL).origin,
      ...env.AUTH_TRUSTED_ORIGINS.split(',').map((s) => s.trim()),
    ].filter(Boolean),
  ),
)

export const config = {
  ...env,
  /** OAuth issuer / JWT issuer: this service's own Better Auth server. */
  issuer: env.BETTER_AUTH_URL,
  /** JWKS endpoint for stateless Bearer JWT verification (Better Auth /jwks). */
  jwksUrl: `${env.BETTER_AUTH_URL}/api/auth/jwks`,
  /** Origins Better Auth trusts for auth requests (self + app + web callback). */
  authTrustedOrigins: trustedOrigins,
  /** Lower-cased email set exempt from the generation quota. */
  quotaExemptEmails: new Set(
    env.QUOTA_EXEMPT_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
  /** True only when every Stripe secret is present; billing routes gate on it. */
  billingEnabled: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_ID),
  /** Fish Audio is selectable (per-user pref) only when its key is configured. */
  fishEnabled: Boolean(env.FISH_API_KEY),
}

export type Config = typeof config
