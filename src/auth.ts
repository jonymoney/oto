import type { RequestHandler } from 'express'
import { Router } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { config } from './config.js'

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000'

const jwks = createRemoteJWKSet(new URL(config.jwksUrl))

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  let payload
  try {
    // Audience is deliberately not enforced: Supabase ignores RFC 8707 resource
    // indicators and issues tokens with aud "authenticated" (documented limitation).
    ;({ payload } = await jwtVerify(token, jwks, { issuer: config.issuer }))
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
 * Bearer-token auth for /mcp. In oauth mode, verifies Supabase JWTs against the
 * project JWKS and attaches AuthInfo to req.auth (which StreamableHTTPServerTransport
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

/** RFC 9728 OAuth Protected Resource Metadata. */
export function wellKnownRouter(): Router {
  const router = Router()
  const metadata = {
    resource: config.MCP_SERVER_URL,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'oto',
    scopes_supported: [],
  }
  const handler: RequestHandler = (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').json(metadata)
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
