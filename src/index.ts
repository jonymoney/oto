import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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

// Stateless Streamable HTTP: a fresh server + transport per request. Survives
// restarts/replicas and avoids long-lived SSE streams hitting Railway's
// 15-minute edge limit.
app.post('/mcp', authMiddleware(), async (req: Request, res: Response) => {
  try {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('MCP request failed:', err)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
})

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed in stateless mode' },
    id: null,
  })
}
app.get('/mcp', methodNotAllowed)
app.delete('/mcp', methodNotAllowed)

await initDb()

const httpServer = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`oto MCP server listening on :${config.PORT} (auth: ${config.AUTH_MODE})`)
})

// Railway sends SIGTERM on redeploy; drain in-flight requests before exiting.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, draining…')
  httpServer.close(() => {
    void closeDb().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(0), 10_000).unref()
})
