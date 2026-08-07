import type { RequestHandler } from 'express'
import { Router } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { fromNodeHeaders } from 'better-auth/node'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { config } from './config.js'
import { auth } from './better-auth.js'

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000'

const jwks = createRemoteJWKSet(new URL(config.jwksUrl))

async function verifyAccessToken(token: string): Promise<AuthInfo> {
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

/** RFC 9728 OAuth Protected Resource Metadata. */
export function wellKnownRouter(): Router {
  const router = Router()
  // Better Auth serves OAuth Authorization Server metadata (RFC 8414) under its
  // handler mount. The issuer identifier is the auth base path; Claude appends
  // /.well-known/oauth-authorization-server to discover the registration,
  // authorize, and token endpoints.
  // ponytail: confirm this exact issuer string against a live Claude handshake;
  // adjust to whatever BA advertises as `issuer` in its AS metadata if it differs.
  const authorizationServer = `${new URL(config.BETTER_AUTH_URL).origin}/api/auth`
  const metadata = {
    resource: config.MCP_SERVER_URL,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ['header'],
    resource_name: 'oto',
    scopes_supported: [],
  }
  const handler: RequestHandler = (_req, res) => {
    res
      .set('Cache-Control', 'public, max-age=3600')
      // Public metadata; browser-based MCP clients fetch it cross-origin.
      .set('Access-Control-Allow-Origin', '*')
      .json(metadata)
  }
  router.get('/.well-known/oauth-protected-resource', handler)
  // Some clients resolve metadata relative to the resource path (/mcp).
  router.get('/.well-known/oauth-protected-resource/mcp', handler)
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
