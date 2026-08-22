// Branded HTML email template shared by all transactional emails. Email clients
// are not browsers: inline styles only (no <style>/classes), table-based layout,
// all colors as hex, no web fonts. Keep it small.

const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"
const SANS = "-apple-system, system-ui, 'Segoe UI', sans-serif"

// Brand palette, light values only — docs/brand/tokens.json. Emails render on
// whatever ground the client picks, so the dark ramp never applies here.
const PAGE_BG = '#F4F7EE'
const CARD_BG = '#FAFCF5'
const TEXT_PRIMARY = '#181A13'
const TEXT_SECONDARY = '#6D7561'
const TEXT_TERTIARY = '#8F977F'
const BORDER = '#DDE3D1'
// accent_text: moegi darkened for legibility at text sizes.
const ACCENT = '#5C7D1E'

export interface RenderEmailOptions {
  heading: string
  bodyHtml: string
  ctaLabel?: string
  ctaUrl?: string
  footnote?: string
}

/** Wrap body content in the branded oto email shell. Returns full HTML. */
export function renderEmail({ heading, bodyHtml, ctaLabel, ctaUrl, footnote }: RenderEmailOptions): string {
  const cta =
    ctaLabel && ctaUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
          <tr><td style="border-radius:8px;background:${ACCENT};">
            <a href="${ctaUrl}" style="display:inline-block;padding:12px 28px;font-family:${SANS};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${ctaLabel}</a>
          </td></tr>
        </table>`
      : ''

  const foot = footnote
    ? `<p style="margin:24px 0 0;font-family:${SANS};font-size:13px;line-height:20px;color:${TEXT_TERTIARY};">${footnote}</p>`
    : ''

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;background:${CARD_BG};border:1px solid ${BORDER};border-radius:16px;">
      <tr><td style="padding:32px;">
        <p style="margin:0 0 24px;font-family:${MONO};font-size:18px;font-weight:600;color:${TEXT_PRIMARY};">
          <span style="color:${ACCENT};">&#9673;</span> oto
        </p>
        <h1 style="margin:0 0 16px;font-family:${SANS};font-size:22px;line-height:28px;font-weight:700;color:${TEXT_PRIMARY};">${heading}</h1>
        <div style="font-family:${SANS};font-size:16px;line-height:24px;color:${TEXT_SECONDARY};">${bodyHtml}</div>
        ${cta}
        ${foot}
      </td></tr>
    </table>
  </td></tr>
</table>`
}

/** Big, monospaced, letter-spaced OTP code block. */
export function otpCodeBlock(otp: string): string {
  return `<div style="margin:24px 0;padding:16px 24px;background:${PAGE_BG};border:1px solid ${BORDER};border-radius:12px;text-align:center;font-family:${MONO};font-size:34px;font-weight:700;letter-spacing:10px;color:${ACCENT};">${otp}</div>`
}
