import { config } from './config.js'

// Swappable email sender. No-ops with a console line when RESEND_API_KEY is
// unset, so local dev works without a Resend account.

/** Send a transactional email via Resend. */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!config.RESEND_API_KEY) {
    console.log(`[email:dev] to=${to} subject=${JSON.stringify(subject)}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: config.AUTH_EMAIL_FROM, to, subject, html }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
}
