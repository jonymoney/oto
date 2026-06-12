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
