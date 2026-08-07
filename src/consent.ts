import { Router } from 'express'

// Better Auth's oidcProvider drives the MCP OAuth handshake and redirects the
// browser to these two paths (configured in src/better-auth.ts):
//   loginPage:   '/login'          — collect identity (email OTP recommended for
//                                    OAuth, since a magic link would drop the
//                                    signed authorization query on redirect).
//   consentPage: '/oauth/consent'  — show scopes, then POST accept/deny.
//
// TODO (fork-dependent, needs a live Claude MCP handshake to build+verify):
// replace these placeholders with a small SPA that calls the Better Auth client
// (authClient.emailOtp.sendVerificationOtp / verify, then oauth2 consent
// accept/deny). The old Supabase-JS consent SPA (public/consent.html) is
// obsolete and no longer served.

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16130f;color:#e8e0d4;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}main{padding:2rem;max-width:34rem}
h1{font-size:1.4rem;letter-spacing:.04em}.led{color:#f5a623}p{line-height:1.6;color:#b8ad9c;font-size:.92rem}</style>
</head><body><main><h1><span class="led">◉</span> oto — ${title}</h1>${body}</main></body></html>`
}

export function consentRouter(): Router {
  const router = Router()
  const guard = (res: import('express').Response) =>
    res
      .setHeader('Cache-Control', 'no-store')
      // An OAuth authorization UI must never render inside a frame (clickjacking).
      .setHeader('X-Frame-Options', 'DENY')
      .setHeader('Content-Security-Policy', "frame-ancestors 'none'")

  router.get('/login', (_req, res) => {
    guard(res)
    res.type('html').send(page('sign in', '<p>Sign-in UI pending — wire the Better Auth email-OTP client here.</p>'))
  })
  router.get(['/consent', '/oauth/consent'], (_req, res) => {
    guard(res)
    res.type('html').send(page('authorize', '<p>Consent UI pending — wire the Better Auth oauth2 consent client here.</p>'))
  })
  return router
}
