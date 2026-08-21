import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { config } from './config.js'
import { initDb, closeDb } from './db.js'
import { buildServer } from './mcp.js'
import { toNodeHandler } from 'better-auth/node'
import { authMiddleware, apiAuthMiddleware, wellKnownRouter } from './auth.js'
import { auth } from './better-auth.js'
import { consentRouter } from './consent.js'
import { legalRouter } from './legal.js'
import { connectRouter } from './connect.js'
import { shareRouter, shortShareRouter } from './share.js'
import { previewsRouter } from './previews.js'
import { apiRouter } from './api.js'
import { handleWebhookEvent } from './billing.js'

const app = express()

// Better Auth owns /api/auth/*. It MUST be mounted before express.json() (it
// reads the raw request body) and before the Bearer-protected /api router
// (it has to issue a session before one can exist). Express 4 wildcard syntax.
app.all('/api/auth/*', toNodeHandler(auth))

// Stripe webhook — MUST be before express.json(): signature verification needs
// the exact raw body. Not behind auth (Stripe calls it directly).
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  if (typeof sig !== 'string') {
    res.status(400).send('Missing stripe-signature')
    return
  }
  try {
    await handleWebhookEvent(req.body as Buffer, sig)
    res.status(200).json({ received: true })
  } catch (err) {
    console.error('Stripe webhook failed:', err)
    res.status(400).send('Webhook error')
  }
})

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
// Also Stripe's business-verification page: name, what we sell, pricing, support contact.
const landingHtml = readFileSync(path.join(publicDir, 'landing.html'), 'utf8')
  .replace('__MCP_URL__', config.MCP_SERVER_URL)
app.get('/', (_req, res) => {
  res.type('html').send(landingHtml)
})
// Landing screenshots: drop pngs into public/img and reference them as /img/<name>.
app.use('/img', express.static(path.join(publicDir, 'img')))

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: https://oto.audio/sitemap.xml\n')
})
app.get('/sitemap.xml', (_req, res) => {
  const urls = ['/', '/terms', '/privacy']
    .map((p) => `<url><loc>https://oto.audio${p}</loc></url>`)
    .join('')
  res.type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`)
})

// Magic-link web handoff: the sign-in email points here (AUTH_WEB_CALLBACK_URL).
// This page never spends the single-use token — it bounces it to the iOS app via
// deep link, so only the app (not an email-client link preview) can consume it.
const authCallbackHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening oto…</title><link rel="icon" type="image/png" href="/icon.png">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16130f;color:#e8e0d4;
       font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}
  main{padding:2rem;max-width:30rem}h1{font-size:1.4rem}.led{color:#f5a623}
  a{display:inline-block;margin-top:1rem;padding:.6rem 1.1rem;border:1px solid #f5a623;border-radius:6px;
    color:#f5a623;text-decoration:none}p{color:#b8ad9c;line-height:1.6}
</style></head><body><main>
  <h1><span class="led">◉</span> oto</h1>
  <p id="msg">Opening the oto app…</p>
  <a id="open" href="#">Open oto</a>
<script>
  var t = new URLSearchParams(location.search).get('token');
  if (t) {
    var deep = 'otoaudio://auth-callback?token=' + encodeURIComponent(t);
    document.getElementById('open').href = deep;
    location.replace(deep); // auto-bounce; the button is the manual fallback
  } else {
    document.getElementById('msg').textContent = 'This sign-in link is missing its token.';
    document.getElementById('open').style.display = 'none';
  }
</script></main></body></html>`
app.get('/auth/callback', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(authCallbackHtml)
})

// Web checkout page for Claude-connector users (no native app): email-OTP
// sign-in, then POST /api/billing/checkout and bounce to Stripe.
const upgradeHtml = readFileSync(path.join(publicDir, 'upgrade.html'))
app.get('/upgrade', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(upgradeHtml)
})

app.use(wellKnownRouter())
app.use(consentRouter())
app.use(legalRouter())
app.use(connectRouter())

// Public share pages (/a/:id) — no auth: the unguessable audio UUID is the
// capability, like a Spotify link. Must stay above the auth-protected routers.
app.use(shareRouter())

// Voice previews for the landing page — same handler iOS uses via /api, but
// public: samples are generated once per (provider, lang, voice) then only
// presigned, so anonymous traffic can't drive synthesis cost.
app.use(previewsRouter())

// REST JSON API for native clients (iOS). Validates the Better Auth session
// bearer via getSession — NOT the JWT path /mcp uses.
app.use('/api', apiAuthMiddleware(), apiRouter())

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

// Short share links (/:username/:slug) — a catch-all, so it MUST stay the last
// registered route: everything above wins first, unknown paths 404 inside it.
app.use(shortShareRouter())

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
