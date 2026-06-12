import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from './config.js'
import { initDb, closeDb } from './db.js'
import { buildServer } from './mcp.js'
import { authMiddleware, wellKnownRouter } from './auth.js'
import { consentRouter } from './consent.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'oto' })
})

// Brand assets: the connector icon Claude shows comes from the domain favicon
// and the MCP serverInfo icons, both served from here.
const publicDir = path.join(process.cwd(), 'public')
const iconPng = readFileSync(path.join(publicDir, 'icon.png'))
const faviconIco = readFileSync(path.join(publicDir, 'favicon.ico'))
app.get('/icon.png', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('png').send(iconPng)
})
app.get('/favicon.ico', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('image/x-icon').send(faviconIco)
})

// Landing for the bare domain: where Site-URL fallbacks and curious visitors end up.
const landingHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>oto — text to speech for your AI chats</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16130f;color:#e8e0d4;
       font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}
  main{padding:2rem;max-width:34rem}
  h1{font-size:1.6rem;letter-spacing:.04em;margin:0 0 .75rem}
  .led{color:#f5a623}
  p{line-height:1.6;color:#b8ad9c;font-size:.92rem}
  code{background:#241f18;padding:.15rem .45rem;border-radius:4px;color:#e8e0d4}
</style></head><body><main>
  <h1><span class="led">◉</span> oto</h1>
  <p>Text to speech inside your AI chat. Generated once, kept forever.</p>
  <p>Connect it in Claude as a custom connector:<br><code>${config.MCP_SERVER_URL}</code></p>
  <p>Just confirmed your email? Head back to your chat and reconnect — sign-in will pick up where you left off.</p>
</main></body></html>`
app.get('/', (_req, res) => {
  res.type('html').send(landingHtml)
})

app.use(wellKnownRouter())
app.use(consentRouter())

// ---------------------------------------------------------------------------
// Stateful Streamable HTTP sessions. Elicitation needs server→client requests
// mid-call, which requires a session (and its SSE streams) to outlive a single
// POST. Sessions live in memory — oto runs as a single replica, so a shared
// session store is unnecessary.
// ---------------------------------------------------------------------------

const SESSION_IDLE_MS = 30 * 60 * 1000
const KEEP_ALIVE_MS = 25_000
const SWEEP_MS = 60_000

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  lastSeen: number
  keepAlive: NodeJS.Timeout
}

const sessions = new Map<string, Session>()

function sessionIdOf(req: Request): string | undefined {
  const id = req.headers['mcp-session-id']
  return typeof id === 'string' ? id : undefined
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })
}

app.post('/mcp', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const sessionId = sessionIdOf(req)
    if (sessionId) {
      const session = sessions.get(sessionId)
      if (!session) {
        // Unknown/expired session: 404 tells spec-compliant clients to reinitialize.
        rpcError(res, 404, -32001, 'Session not found')
        return
      }
      session.lastSeen = Date.now()
      await session.transport.handleRequest(req, res, req.body)
      return
    }

    if (!isInitializeRequest(req.body)) {
      rpcError(res, 400, -32000, 'Bad Request: no valid session ID provided')
      return
    }

    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        // Railway's edge kills streams idle for ~60s; ping the client over the
        // session's SSE stream often enough to keep it open. Failures (e.g. no
        // GET stream open yet, ping timeout) are harmless.
        const keepAlive = setInterval(() => {
          server.server.ping().catch(() => {})
        }, KEEP_ALIVE_MS)
        sessions.set(id, { transport, server, lastSeen: Date.now(), keepAlive })
      },
    })
    // Assigned before connect(): Protocol.connect chains (not replaces) an
    // existing onclose, so both this cleanup and the protocol's teardown run.
    transport.onclose = () => {
      const id = transport.sessionId
      if (!id) return
      const session = sessions.get(id)
      if (session) {
        clearInterval(session.keepAlive)
        sessions.delete(id)
      }
    }
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    if (!transport.sessionId) {
      // Malformed initialize: no session was created, so nothing references
      // this server/transport pair — close it instead of leaking it.
      void transport.close()
    }
  } catch (err) {
    console.error('MCP request failed:', err)
    if (!res.headersSent) {
      rpcError(res, 500, -32603, 'Internal server error')
    }
  }
})

// GET opens the server→client SSE stream (required for elicitation); DELETE is
// spec-compliant session termination (the transport closes itself, and onclose
// above evicts the session). Both carry only headers, which is all
// requireBearerAuth reads — it never touches the body.
const handleSessionRequest = async (req: Request, res: Response) => {
  try {
    const sessionId = sessionIdOf(req)
    const session = sessionId ? sessions.get(sessionId) : undefined
    if (!session) {
      rpcError(res, 404, -32001, 'Session not found')
      return
    }
    session.lastSeen = Date.now()
    await session.transport.handleRequest(req, res)
  } catch (err) {
    console.error('MCP request failed:', err)
    if (!res.headersSent) {
      rpcError(res, 500, -32603, 'Internal server error')
    }
  }
}
app.get('/mcp', authMiddleware(), handleSessionRequest)
app.delete('/mcp', authMiddleware(), handleSessionRequest)

// Evict sessions whose client vanished without a DELETE; closing the transport
// triggers onclose, which clears the keep-alive timer and the map entry.
const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS
  for (const session of sessions.values()) {
    if (session.lastSeen < cutoff) {
      session.transport.close().catch(() => {})
    }
  }
}, SWEEP_MS)
sweepTimer.unref()

await initDb()

const httpServer = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`oto MCP server listening on :${config.PORT} (auth: ${config.AUTH_MODE})`)
})

// Railway sends SIGTERM on redeploy; close all sessions first (ending their
// SSE streams so httpServer.close can drain), then exit.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, draining…')
  clearInterval(sweepTimer)
  for (const session of sessions.values()) {
    session.transport.close().catch(() => {})
  }
  httpServer.close(() => {
    void closeDb().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(0), 10_000).unref()
})
