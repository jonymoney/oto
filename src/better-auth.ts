import { betterAuth } from 'better-auth'
import {
  bearer,
  emailOTP,
  jwt,
  magicLink,
  oidcProvider,
} from 'better-auth/plugins'
import { pool, deleteUserData } from './db.js'
import { deleteAudioObject } from './storage.js'
import { config } from './config.js'
import { sendEmail } from './senders.js'
import { renderEmail, otpCodeBlock } from './email-template.js'

const THIRTY_DAYS = 60 * 60 * 24 * 30
const FIFTEEN_MIN = 60 * 15

/**
 * Self-hosted Better Auth server. Serves two consumers:
 *  - iOS / REST: bearer() sessions (the bearer token IS the session; a 401 means
 *    re-authenticate — there is no refresh token), obtained via magicLink/SMS OTP.
 *  - MCP connector (Claude): oidcProvider is the OAuth 2.1 authorization server
 *    (Dynamic Client Registration + PKCE + consent), issuing JWT access tokens
 *    the /mcp endpoint verifies statelessly against the jwt() plugin's JWKS.
 */
export const auth = betterAuth({
  baseURL: config.BETTER_AUTH_URL,
  secret: config.BETTER_AUTH_SECRET,
  // Reuse the app's pg pool; Better Auth uses its built-in Kysely adapter.
  database: pool,
  trustedOrigins: config.authTrustedOrigins,
  advanced: {
    // Preserve Supabase UUIDs so audios.user_id / usage_counters.user_id stay valid.
    database: { generateId: 'uuid' },
    // Behind Railway's proxy the client IP is in x-forwarded-for; without this,
    // rate limiting falls back to a single shared bucket for everyone.
    ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
  },
  // Sliding 30-day session (refreshed daily on use). freshAge 0 disables the
  // "fresh session" gate on sensitive endpoints (delete-user): our users sign
  // in via magic link / OTP, have no password to re-verify with, and hold
  // 30-day sessions — the default 1-day freshness window would make deletion
  // impossible for anyone signed in longer than a day.
  session: { expiresIn: THIRTY_DAYS, updateAge: 60 * 60 * 24, freshAge: 0 },
  user: {
    modelName: 'users',
    additionalFields: {
      // Server-managed; never accepted from client input.
      role: { type: 'string', required: false, input: false },
    },
    // POST /api/auth/delete-user with the bearer session token, body {}.
    // No sendDeleteAccountVerification: the bearer session IS the proof —
    // an email round-trip adds nothing for passwordless users, so the user
    // is deleted immediately.
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        // Rows first (FKs reference users), then bucket objects best-effort —
        // rows are gone, orphaned objects are harmless.
        const objectKeys = await deleteUserData(user.id)
        for (const key of [...objectKeys, `avatars/${user.id}.jpg`]) {
          try {
            await deleteAudioObject(key)
          } catch (err) {
            console.error(`account delete: failed to remove bucket object ${key}:`, err)
          }
        }
      },
    },
  },
  account: { accountLinking: { enabled: true } },
  plugins: [
    // Asymmetric JWTs + JWKS endpoint for stateless /mcp verification.
    // Pin ES256 (default is EdDSA) so the /mcp verifier accepts a single alg.
    jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
    // Bearer token == session for the iOS/REST client.
    bearer(),
    // 15-minute single-use magic link. The email points at a WEB HANDOFF page
    // (AUTH_WEB_CALLBACK_URL) that deep-links the token to the app, so only the
    // app spends the single-use token (email previews can't burn it).
    magicLink({
      expiresIn: FIFTEEN_MIN,
      sendMagicLink: async ({ email, token, url }) => {
        const link = config.AUTH_WEB_CALLBACK_URL
          ? `${config.AUTH_WEB_CALLBACK_URL}?token=${encodeURIComponent(token)}`
          : url
        // ponytail: with no Resend key the email can't send, so surface the link
        // in the logs to unblock testing (e.g. against prod before Resend is set
        // up). Remove once real email delivery is in place.
        if (!config.RESEND_API_KEY) console.log(`[magic-link] ${email} -> ${link}`)
        await sendEmail(
          email,
          'Your oto sign-in link',
          renderEmail({
            heading: 'Sign in to oto',
            bodyHtml: '<p style="margin:0;">Tap the button below to sign in to oto.</p>',
            ctaLabel: 'Sign in',
            ctaUrl: link,
            footnote: 'This link expires in 15 minutes and can be used once. If you didn&rsquo;t request it, you can ignore this email.',
          }),
        )
      },
    }),
    // 6-digit email OTP — used for web/OAuth sign-in where a magic link would
    // lose the signed authorization query on redirect.
    emailOTP({
      otpLength: 6,
      expiresIn: FIFTEEN_MIN,
      sendVerificationOTP: async ({ email, otp }) => {
        await sendEmail(
          email,
          'Your oto verification code',
          renderEmail({
            heading: 'Your verification code',
            bodyHtml: `<p style="margin:0;">Enter this code to sign in to oto.</p>${otpCodeBlock(otp)}`,
            footnote: 'This code expires in 15 minutes. If you didn&rsquo;t request it, you can ignore this email.',
          }),
        )
      },
    }),
    // ponytail: SMS OTP dropped from v1 (magic-link only per iOS scope). Re-add
    // the phoneNumber() plugin + Surge sender + SURGE_* env if phone sign-in returns.
    // OAuth 2.1 authorization server for the MCP handshake.
    oidcProvider({
      loginPage: '/login',
      consentPage: '/oauth/consent',
      // Claude self-registers via RFC 7591 Dynamic Client Registration.
      allowDynamicClientRegistration: true,
      // Sign access/id tokens with the jwt() plugin's asymmetric keys so /mcp
      // can verify them statelessly via JWKS.
      useJWTPlugin: true,
    }),
  ],
})
