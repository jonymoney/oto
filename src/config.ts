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

  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),

  DATABASE_URL: z.string().min(1),

  BUCKET_NAME: z.string().min(1),
  BUCKET_ENDPOINT: z.string().url().default('https://storage.railway.app'),
  BUCKET_REGION: z.string().default('auto'),
  BUCKET_ACCESS_KEY_ID: z.string().min(1),
  BUCKET_SECRET_ACCESS_KEY: z.string().min(1),
  AUDIO_URL_TTL_SECONDS: z.coerce.number().default(3600),

  // 'disabled' skips OAuth for local development only — never in production.
  AUTH_MODE: z.enum(['oauth', 'disabled']).default('oauth'),
})

const env = EnvSchema.parse(process.env)

export const config = {
  ...env,
  /** OAuth issuer: Supabase Auth acts as the authorization server. */
  issuer: `${env.SUPABASE_URL}/auth/v1`,
  /** JWKS endpoint for stateless Bearer JWT verification (ES256). */
  jwksUrl: `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
}

export type Config = typeof config
