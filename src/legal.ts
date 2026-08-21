import { Router } from 'express'

const CONTACT = 'ijonathanvs@gmail.com'
const EFFECTIVE = 'August 20, 2026'

/** Shared shell for the static text pages (matches the share-page palette). */
function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — oto</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>
body{margin:0;background:#f4f1ea;color:#16130f;font-family:ui-monospace,'SF Mono',Menlo,monospace}
main{max-width:42rem;margin:0 auto;padding:2.5rem 1.5rem 4rem;line-height:1.65}
.brand{font-size:.95rem;letter-spacing:.04em;margin-bottom:2rem}
.brand a{color:#16130f;text-decoration:none;font-weight:700}.brand a:hover{color:#f5a623}
.led{color:#f5a623}
h1{font-size:1.35rem;margin:0 0 .3rem}
.date{color:#6f6555;font-size:.82rem;margin:0 0 2rem}
h2{font-size:1rem;margin:2rem 0 .5rem}
p,li{color:#3d372d;font-size:.9rem}
ul{padding-left:1.2rem}
a{color:#16130f;font-weight:700;text-decoration:none}a:hover{color:#f5a623}
footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid #e3dccc;font-size:.82rem;color:#6f6555}
footer a{margin-right:1rem}
</style></head><body><main>
<div class="brand"><a href="/"><span class="led">◉</span> oto</a></div>
${bodyHtml}
<footer><a href="/">Home</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/connect">Connect</a></footer>
</main></body></html>`
}

const privacyHtml = page(
  'Privacy',
  `<h1>Privacy Policy</h1>
<p class="date">Effective ${EFFECTIVE}</p>

<h2>What we collect</h2>
<ul>
<li>Your email address, used to sign you in and identify your account.</li>
<li>The text you convert to speech, and the generated audio files.</li>
<li>Titles, summaries, tags, and mood labels that the AI attaches to your audios.</li>
<li>Playback positions, so you can pick up where you left off.</li>
<li>Usage minutes, to track your plan's quota.</li>
<li>If you subscribe, a Stripe customer id. We never see or store your card details.</li>
</ul>

<h2>Who processes it</h2>
<ul>
<li><strong>OpenAI</strong> — text-to-speech synthesis. Your text is sent to them to generate audio.</li>
<li><strong>Fish Audio</strong> — text-to-speech for the fish voices. Your text is sent to them when you use one of those voices.</li>
<li><strong>Stripe</strong> — billing for the paid plan.</li>
<li><strong>Resend</strong> — delivers sign-in emails.</li>
<li><strong>Railway</strong> — hosts the service, database, and audio storage.</li>
</ul>

<h2>Retention</h2>
<p>Your audio and its source text are kept until you delete the audio or delete your account. Deleting your account removes your data and your stored audio files.</p>

<h2>Your rights</h2>
<p>You can access everything you've generated from your library at any time. You can delete individual audios, and you can delete your entire account from inside the app — deletion is built in, no email required. Questions or requests: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

<h2>Cookies and tracking</h2>
<p>oto sets a single strictly-necessary session cookie to keep you signed in. No analytics, no ads, no third-party trackers.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
)

const termsHtml = page(
  'Terms',
  `<h1>Terms of Service</h1>
<p class="date">Effective ${EFFECTIVE}</p>

<h2>The service</h2>
<p>oto converts text to speech inside your AI chat and keeps the generated audio in your library. Audio is generated once and stored, so replays never re-generate.</p>

<h2>Accounts</h2>
<p>You sign in with your email. You're responsible for what happens under your account. One account per person, please.</p>

<h2>Free quota and paid plan</h2>
<p>The free plan includes a monthly quota of generated audio. The paid plan raises it. Quotas reset monthly; unused minutes don't roll over.</p>

<h2>Acceptable use</h2>
<ul>
<li>Don't impersonate real people with synthetic voices.</li>
<li>Voices come from third-party providers under their licenses; use them within those terms.</li>
<li>You're responsible for having the rights to any text you convert.</li>
<li>No illegal content, and nothing that harasses or defrauds others.</li>
</ul>

<h2>Share links</h2>
<p>Anyone with a share link can listen to that audio. Visibility settings govern where your audios can be discovered — they don't restrict a share link you've already handed out.</p>

<h2>Copyright and takedowns</h2>
<p>If you believe content on oto infringes your copyright, email <a href="mailto:${CONTACT}">${CONTACT}</a> with the share link and a description of the work. We'll review and remove infringing content promptly.</p>

<h2>Disclaimer of warranties</h2>
<p>oto is provided "as is", without warranties of any kind. We don't guarantee uninterrupted service or that generated audio fits any particular purpose.</p>

<h2>Termination</h2>
<p>You can delete your account at any time from inside the app. We may suspend or terminate accounts that violate these terms.</p>

<h2>Changes</h2>
<p>We may update these terms; the effective date above will change when we do. Continued use after a change means you accept the new terms.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
)

export function legalRouter(): Router {
  const router = Router()
  router.get('/terms', (_req, res) => {
    res.type('html').send(termsHtml)
  })
  router.get('/privacy', (_req, res) => {
    res.type('html').send(privacyHtml)
  })
  return router
}
