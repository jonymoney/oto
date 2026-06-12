import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { config } from './config.js'

let cachedHtml: string | null = null

function loadConsentHtml(): string {
  if (cachedHtml === null) {
    const filePath = path.join(process.cwd(), 'public', 'consent.html')
    cachedHtml = readFileSync(filePath, 'utf8')
      .replaceAll('__SUPABASE_URL__', config.SUPABASE_URL)
      .replaceAll('__SUPABASE_PUBLISHABLE_KEY__', config.SUPABASE_PUBLISHABLE_KEY)
  }
  return cachedHtml
}

/**
 * Serves the Supabase OAuth consent page. Supabase redirects the browser here
 * with an `authorization_id` query parameter (Authorization Path in the
 * Supabase dashboard is `/oauth/consent`); both paths are registered so the
 * router works mounted at the app root or under `/oauth`.
 */
export function consentRouter(): Router {
  const html = loadConsentHtml() // read once at startup — fail fast if missing
  const router = Router()
  router.get(['/consent', '/oauth/consent'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    // An OAuth authorization UI must never render inside a frame (clickjacking).
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    res.type('html').send(html)
  })
  return router
}
