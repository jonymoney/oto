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
}

export type Config = typeof config
