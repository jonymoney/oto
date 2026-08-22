import type { RequestHandler } from 'express'
import { Router } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { fromNodeHeaders } from 'better-auth/node'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { config } from './config.js'
import { auth } from './better-auth.js'
import { pool } from './db.js'

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000'

const jwks = createRemoteJWKSet(new URL(config.jwksUrl))

// Better Auth's oidcProvider issues OPAQUE access tokens (random strings stored
// in oauthAccessToken) — useJWTPlugin only makes the id_token a JWT. The MCP
// connector therefore presents an opaque bearer; validate it the same way the
// oauth2/userinfo endpoint does: a lookup + expiry check.
async function verifyOpaqueToken(token: string): Promise<AuthInfo> {
  const { rows } = await pool.query(
    `select t."userId", t.scopes, t."clientId", t."accessTokenExpiresAt", u.email
       from "oauthAccessToken" t join users u on u.id = t."userId"
      where t."accessToken" = $1`,
    [token],
  )
  const row = rows[0]
  if (!row) throw new InvalidTokenError('Unknown access token')
  if (row.accessTokenExpiresAt < new Date()) throw new InvalidTokenError('Access token expired')
  return {
    token,
    clientId: row.clientId,
    scopes: typeof row.scopes === 'string' ? row.scopes.split(' ') : [],
    expiresAt: Math.floor(new Date(row.accessTokenExpiresAt).getTime() / 1000),
    extra: { userId: row.userId, email: row.email },
  }
}

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  // Opaque OAuth token (no JWS structure) → DB-backed check. JWTs (three
  // dot-separated segments) — e.g. the /api/auth/token endpoint's — go
  // through JWKS verification below.
  if (token.split('.').length !== 3) return verifyOpaqueToken(token)
  let payload
  try {
    // Audience is deliberately not enforced: the JWT-endpoint token has aud =
    // BETTER_AUTH_URL while an OAuth access token bound to a resource has aud =
    // the resource (MCP_SERVER_URL). Both are trusted here.
    // ponytail: tighten to aud === MCP_SERVER_URL once verified against a real
    // Claude MCP handshake.
    ;({ payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      // Better Auth's jwt() plugin is pinned to ES256 (see src/better-auth.ts).
      algorithms: ['ES256'],
    }))
  } catch (err) {
    throw new InvalidTokenError(err instanceof Error ? err.message : 'Token verification failed')
  }
  if (!payload.sub) {
    throw new InvalidTokenError('Token has no sub claim')
  }
  return {
    token,
    clientId: String(payload.client_id ?? 'unknown'),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
    expiresAt: payload.exp,
    extra: { userId: payload.sub, email: payload.email },
  }
}

/**
 * Bearer-token auth for /mcp. In oauth mode, verifies Better Auth ES256 JWTs
 * against its JWKS and attaches AuthInfo to req.auth (which StreamableHTTPServerTransport
 * forwards to tool callbacks as extra.authInfo). 401s carry a WWW-Authenticate header
 * pointing at the RFC 9728 protected-resource metadata.
 */
export function authMiddleware(): RequestHandler {
  if (config.AUTH_MODE === 'disabled') {
    return (req, _res, next) => {
      req.auth = {
        token: 'dev',
        clientId: 'dev',
        scopes: [],
        extra: { userId: DEV_USER_ID },
      }
      next()
    }
  }
  const resourceMetadataUrl = `${new URL(config.MCP_SERVER_URL).origin}/.well-known/oauth-protected-resource`
  return requireBearerAuth({ verifier: { verifyAccessToken }, resourceMetadataUrl })
}

/**
 * Bearer-token auth for the REST /api (iOS app). The app's bearer is a Better
 * Auth SESSION token (opaque, not a JWT), so it's validated via getSession —
 * NOT the JWKS/JWT path that /mcp uses for OAuth access tokens. Sets req.auth in
 * the same shape so userIdFrom/authUserFrom and the /api handlers are unchanged.
 */
export function apiAuthMiddleware(): RequestHandler {
  if (config.AUTH_MODE === 'disabled') {
    return (req, _res, next) => {
      req.auth = { token: 'dev', clientId: 'dev', scopes: [], extra: { userId: DEV_USER_ID } }
      next()
    }
  }
  return async (req, res, next) => {
    try {
      const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
      if (!result?.user) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      req.auth = {
        token: 'session',
        clientId: 'oto-app',
        scopes: [],
        extra: { userId: result.user.id, email: result.user.email },
      }
      next()
    } catch {
      res.status(401).json({ error: 'Unauthorized' })
    }
  }
}

const authOrigin = new URL(config.BETTER_AUTH_URL).origin
const oidcConfigUrl = `${authOrigin}/api/auth/.well-known/openid-configuration`

/**
 * Better Auth publishes its OAuth metadata at ONE place — the OIDC document
 * under its own mount — and that document declares `issuer` as the bare origin.
 * RFC 8414 §3.3 requires `issuer` to equal the authorization-server identifier
 * the client started discovery from, and §3.1 puts the document under the
 * ORIGIN's well-known path. So advertise the origin as the authorization
 * server, and mirror the document here where the spec says to look. Clients
 * that only try the OIDC path still find the original, unchanged.
 *
 * Mirrored rather than hand-written so it can't drift from what Better Auth
 * actually serves; cached after the first success (registrations are static).
 */
let asMetadata: unknown = null
async function authServerMetadata(): Promise<unknown> {
  if (asMetadata === null) {
    const res = await fetch(oidcConfigUrl)
    if (!res.ok) throw new Error(`Better Auth OIDC metadata unavailable (${res.status})`)
    asMetadata = await res.json()
  }
  return asMetadata
}

/** RFC 9728 OAuth Protected Resource Metadata + RFC 8414 Authorization Server Metadata. */
export function wellKnownRouter(): Router {
  const router = Router()
  const metadata = {
    resource: config.MCP_SERVER_URL,
    // Origin first (spec-correct, matches the advertised issuer); the legacy
    // path-based identifier stays as a fallback for anything already using it.
    authorization_servers: [authOrigin, `${authOrigin}/api/auth`],
    bearer_methods_supported: ['header'],
    resource_name: 'oto',
    scopes_supported: [],
  }
  const publicJson: RequestHandler = (_req, res, next) => {
    res
      .set('Cache-Control', 'public, max-age=3600')
      // Public metadata; browser-based MCP clients fetch it cross-origin.
      .set('Access-Control-Allow-Origin', '*')
    next()
  }
  const handler: RequestHandler = (_req, res) => {
    res.json(metadata)
  }
  router.get('/.well-known/oauth-protected-resource', publicJson, handler)
  // Some clients resolve metadata relative to the resource path (/mcp).
  router.get('/.well-known/oauth-protected-resource/mcp', publicJson, handler)

  // RFC 8414 §3.1: <origin>/.well-known/oauth-authorization-server, plus the
  // path-insertion form for the legacy /api/auth identifier.
  const asHandler: RequestHandler = async (_req, res) => {
    try {
      res.json(await authServerMetadata())
    } catch (err) {
      console.error('Authorization server metadata failed:', err)
      res.status(502).json({ error: 'authorization_server_metadata_unavailable' })
    }
  }
  router.get('/.well-known/oauth-authorization-server', publicJson, asHandler)
  router.get('/.well-known/oauth-authorization-server/api/auth', publicJson, asHandler)
  return router
}

/** Resolves the authenticated user id from a tool callback's extra.authInfo. */
export function userIdFrom(extra: { authInfo?: AuthInfo }): string {
  const userId = extra.authInfo?.extra?.userId
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('Unauthenticated')
  }
  return userId
}

/** Like userIdFrom, but also returns the token's email claim when present. */
export function authUserFrom(extra: { authInfo?: AuthInfo }): { userId: string; email?: string } {
  const userId = userIdFrom(extra)
  const email = extra.authInfo?.extra?.email
  return { userId, email: typeof email === 'string' && email.length > 0 ? email : undefined }
}
