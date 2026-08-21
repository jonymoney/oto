import { Router } from 'express'

const CONTACT = 'ijonathanvs@gmail.com'
const EFFECTIVE = 'August 21, 2026'
const UPDATED = 'August 21, 2026'

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
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.85rem;margin:.5rem 0 1rem}
th,td{border:1px solid #e3dccc;padding:.45rem .6rem;text-align:left;color:#3d372d;vertical-align:top}
th{color:#16130f}
.todo{background:#fbe9c8;padding:.1rem .3rem}
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
<p class="date">Effective ${EFFECTIVE} · Last updated ${UPDATED}</p>

<p>oto turns text into speech and keeps the audio in your library. This policy explains what
data that involves, who touches it, and what control you have. The short version: we store what
the product needs to work, we send your text to a speech provider to make the audio, and we
don't run analytics, ads, or trackers.</p>

<h2>What we collect</h2>
<ul>
<li><strong>Account</strong> — your email address (sign-in and account identity), a username if
you claim one, and an avatar photo if you upload one.</li>
<li><strong>Content</strong> — the text you convert to speech, the generated audio files, and the
titles, summaries, emoji, tags, language, and mood labels attached to each audio. Those labels are
supplied by the AI assistant you use oto through (for example Claude) when it calls oto; we store
them with the audio.</li>
<li><strong>Usage</strong> — playback positions (so you can resume), when an audio was last
played, and a running count of how much audio you've generated (your quota).</li>
<li><strong>Social</strong> — who you follow, which audios you've saved, and the collections you
create.</li>
<li><strong>Billing</strong> — if you subscribe, your Stripe customer id and subscription status.
Your card details go directly to Stripe and never touch oto's servers.</li>
<li><strong>Device</strong> — nothing. No analytics, no advertising identifiers, no tracking, no
fingerprinting.</li>
</ul>

<h2>How we use it, and on what basis</h2>
<p>We use this data to provide the service you asked for: generating audio, storing your library,
syncing playback across devices, running the social features you opt into, and billing the paid
plan. For users in the EU/EEA and UK, the lawful basis for all of that is
<strong>performance of a contract</strong> (these are the features you signed up for). Keeping
quota counters, preventing abuse, and securing the service rest on our
<strong>legitimate interest</strong> in running oto safely. We don't use your data for anything
else — no profiling, no selling, no sharing for advertising. We have never sold or shared personal
information as those terms are defined in the California Consumer Privacy Act.</p>

<h2>Who processes it</h2>
<p>oto uses a small set of processors, each receiving only what its job needs:</p>
<div class="tablewrap"><table>
<tr><th>Processor</th><th>What it receives</th><th>Why</th></tr>
<tr><td>OpenAI</td><td>The text you convert (and optional delivery instructions)</td><td>Speech synthesis for the built-in voices</td></tr>
<tr><td>Fish Audio</td><td>The text you convert</td><td>Speech synthesis when you pick a Fish voice</td></tr>
<tr><td>Stripe</td><td>Your email and payment details (entered on Stripe's pages)</td><td>Subscription billing</td></tr>
<tr><td>Resend</td><td>Your email address</td><td>Delivering sign-in codes and links</td></tr>
<tr><td>Railway</td><td>Everything above at rest</td><td>Hosts oto's servers, database, and audio storage</td></tr>
</table></div>
<p>Your text is sent to exactly one speech provider per generation — the one behind the voice you
chose. There are no other third parties.</p>

<h2>What's public</h2>
<p>If you claim a username, your profile page shows your username, your avatar, and the audios you
have set to <strong>public</strong> (their titles, covers, and playback). Audios set to
followers, friends, or private don't appear there. Separately, every audio has a share link:
<strong>anyone who has the link can listen</strong>, whatever the visibility setting — visibility
controls where an audio is listed, not whether a link you handed out works. Share pages are
public web pages and may be cached by browsers and intermediaries.</p>

<h2>Retention and deletion</h2>
<p>Your audio, its source text, and its metadata are kept until you delete that audio or delete
your account. Deleting an audio removes it everywhere — from your library, from share links, and
from other users' saves and collections, which reference your original. Deleting your account
(built into the app, no email required) removes your account data and your stored audio files.</p>
<p>The iOS app can keep downloaded copies of audios and resume positions on your device. Those
copies live on your device under your control; deleting the app or the download removes them.</p>

<h2>Your rights</h2>
<p>You can see everything you've generated in your library, fix your username and avatar in the
app, delete individual audios, and delete your entire account — all in-app, no request needed. If
you want a copy of your data in a portable format, or anything the app doesn't cover (access,
rectification, erasure, restriction, objection, portability), email
<a href="mailto:${CONTACT}">${CONTACT}</a> and we'll handle it. EU/EEA and UK users can also
complain to their local data protection authority; California residents have equivalent rights
under the CCPA/CPRA and we honor them without discrimination.</p>

<h2>International transfer</h2>
<p>oto runs on infrastructure in the United States. If you use oto from outside the US (including
the EU/EEA and UK), your data is transferred to and stored in the US. We rely on our processors'
safeguards (such as standard contractual clauses and Data Privacy Framework participation, where
applicable) for those transfers.</p>

<h2>Children</h2>
<p>oto is not directed at children under 13, and we don't knowingly collect personal information
from them. If you believe a child under 13 has an account, contact us and we'll delete it.</p>

<h2>Cookies</h2>
<p>oto sets a single strictly-necessary session cookie to keep you signed in on the web. That's
it — no analytics cookies, no ad cookies, no third-party trackers, which is why there's no cookie
banner.</p>

<h2>Changes</h2>
<p>If this policy changes, we'll update the date above; for material changes we'll notify you in
the app or by email before they take effect.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
)

const termsHtml = page(
  'Terms',
  `<h1>Terms of Service</h1>
<p class="date">Effective ${EFFECTIVE} · Last updated ${UPDATED}</p>

<h2>The service</h2>
<p>oto converts text to speech and keeps the generated audio in your library. You use it through
AI chat apps that support MCP (such as Claude), through the oto iOS app, and on the web. Each
audio is generated once and stored; replays serve the stored file. Identical text with the same
voice reuses the existing audio instead of generating again. The AI client you connect through is
third-party software under its own terms — oto doesn't control what your assistant does with your
conversation outside of the oto tools it calls.</p>

<h2>Eligibility</h2>
<p>You must be at least 13 years old to use oto. If you're under the age of majority where you
live, you may only use oto with a parent or guardian's permission. By using oto you confirm you
meet these requirements.</p>

<h2>Your account</h2>
<p>You sign in with your email — a code or link is sent to it, so keeping that inbox secure is
keeping your account secure. You're responsible for what happens under your account. One account
per person, please.</p>

<h2>Free quota and oto unlimited</h2>
<p>The free plan includes a fixed allowance of generated audio. It's a running total, not a
monthly one: it doesn't reset, replaying stored audio is always free and never counts, and
deleting an audio doesn't give minutes back. The paid <strong>oto unlimited</strong> subscription
removes the cap and unlocks the premium (Fish Audio) voices; voice previews are free for
everyone. "Unlimited" means normal personal use — we may throttle or refuse automated,
resold, or clearly abusive generation volume. Subscriptions are billed and managed through
Stripe and can be cancelled any time from the billing portal.</p>

<h2>Your content</h2>
<p>The text you submit and the audio generated from it are yours — oto claims no ownership. You
grant oto a limited, non-exclusive license to host, process, and serve that content in order to
run the service: sending your text to the speech provider, storing the audio, streaming it back
to you, and — when you share a link or set an audio to a visible setting — serving it on public
share and profile pages, including to other users who save it. This license ends when you delete
the content, except for short-lived cached copies already in transit. You're responsible for
having the rights to any text you convert.</p>

<h2>Synthetic voices</h2>
<p>Every voice in oto is synthetic. The built-in voices come from OpenAI and the premium voices
from the Fish Audio marketplace; both are provided under those providers' licenses and usage
policies, which pass through to your use. oto offers no voice cloning: you can't create a voice
of a specific real person, and you must not use any voice to imitate or impersonate one — no
celebrity voices, no fake recordings of real people. When you share generated audio in contexts
where listeners could reasonably believe a real person is speaking, make clear it's synthetic.</p>

<h2>Acceptable use</h2>
<ul>
<li>No impersonating real people or organizations, and no audio presented as a genuine recording
of someone.</li>
<li>No illegal content, and nothing that defrauds, deceives, harasses, or threatens others.</li>
<li>No converting text you don't have the rights to.</li>
<li>No scraping, bulk-downloading other users' content, probing, or circumventing quotas, rate
limits, or access controls.</li>
<li>Use within the speech providers' own usage policies (OpenAI's usage policies and Fish Audio's
voice licenses apply to audio made with their voices).</li>
</ul>

<h2>Sharing and visibility</h2>
<p>These two mechanisms are different, and it matters:</p>
<ul>
<li><strong>Share links are keys.</strong> Every audio has an unguessable link; anyone who has it
can listen, regardless of the audio's visibility setting. Treat handing out a link like handing
out the audio.</li>
<li><strong>Visibility controls discovery.</strong> Private, followers, friends (mutual
follows), or public decide where an audio is listed — on your public profile, in Explore, in
followers' feeds. Changing visibility doesn't revoke links you've already shared.</li>
</ul>
<p>The one way to withdraw an audio is to delete it: deletion removes it from your library, kills
its share links, and removes it from every other user's saves and collections.</p>

<h2>Social features</h2>
<p>You can follow other users, save their audios, and organize saves into collections. Saving
references the original — it doesn't copy it, so if the owner deletes an audio it disappears from
your saves too. If you claim a username, your profile (username, avatar, public audios) is a
public page.</p>

<h2>Copyright complaints (DMCA)</h2>
<p>If you believe content on oto infringes your copyright, send a notice to
<a href="mailto:${CONTACT}">${CONTACT}</a> including: (1) the share link or URL of the material,
(2) identification of the copyrighted work, (3) your contact information, (4) a statement that
you believe in good faith the use is not authorized by the owner, its agent, or the law, (5) a
statement, under penalty of perjury, that the notice is accurate and you are the owner or
authorized to act for them, and (6) your physical or electronic signature. We'll remove or
disable access to infringing content promptly and notify the user who posted it.</p>
<p>If your content was removed and you believe it was a mistake or misidentification, you may
send a counter-notice to the same address with the material's former URL, a statement under
penalty of perjury of your good-faith belief, your contact information, consent to the
jurisdiction of the federal court for your district (or ours, if outside the US), and your
signature. Unless the complainant files a court action, removed content may be restored in
10–14 business days.</p>
<p><strong>Repeat infringers lose their accounts.</strong> We terminate the accounts of users who
are the subject of repeated valid infringement notices.</p>

<h2>Termination</h2>
<p>You can delete your account at any time from inside the app; that removes your data and stored
audio. We may suspend or terminate accounts that violate these terms, with notice where
practical. Quota allowances and subscriptions aren't refunded on termination for violation.</p>

<h2>Disclaimers</h2>
<p>oto is provided "as is" and "as available", without warranties of any kind, express or
implied. We don't guarantee uninterrupted service, that generated audio is accurate or fits any
particular purpose, or that stored files are a substitute for your own backups.</p>

<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, oto and its operator are not liable for indirect,
incidental, consequential, or punitive damages, or for lost profits or data. Our total liability
for any claim relating to the service is capped at the greater of what you paid oto in the twelve
months before the claim or US$50. Nothing here limits liability that can't legally be limited.</p>

<h2>Indemnification</h2>
<p>If someone brings a claim against oto because of content you submitted or your violation of
these terms, you agree to cover the reasonable costs and damages that result. This is meant to be
proportionate: it applies to your content and your conduct, not to oto's own failures.</p>

<h2>Governing law</h2>
<p><span class="todo">[to be completed — governing law and venue, and whether disputes go to
arbitration, must be chosen with legal counsel before this section is final]</span></p>

<h2>Changes</h2>
<p>We may update these terms; the dates above will change when we do, and for material changes
we'll notify you in the app or by email before they take effect. Continued use after a change
means you accept the new terms.</p>

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
