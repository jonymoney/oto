import { json, Router } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from './better-auth.js'
import { pool } from './db.js'

// Better Auth's oidcProvider drives the MCP OAuth handshake and redirects the
// browser to these two paths (configured in src/better-auth.ts):
//   loginPage:   '/login?<original authorize query>' — no session yet. Sign the
//     user in (email OTP; a magic link would drop the query on redirect), then
//     send the browser back to /api/auth/oauth2/authorize?<same query>.
//   consentPage: '/oauth/consent?consent_code=..&client_id=..&scope=..' — POST
//     /api/auth/oauth2/consent {accept, consent_code} -> {redirectURI}.

function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#181A13;color:#EEF1E5;
font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}main{padding:2rem;max-width:34rem}
h1{font-size:1.4rem;letter-spacing:.04em}.led{color:#AACF53}p{line-height:1.6;color:#99A189;font-size:.92rem}
input{background:#12140E;color:#EEF1E5;border:1px solid #2C3025;border-radius:8px;padding:.7rem .9rem;
font:inherit;width:100%;box-sizing:border-box;text-align:center;margin:.4rem 0}
input:focus{outline:none;border-color:#AACF53}
button{background:#AACF53;color:#181A13;border:none;border-radius:8px;padding:.7rem 1.4rem;font:inherit;
font-weight:700;cursor:pointer;margin:.4rem .3rem}button:disabled{opacity:.5;cursor:default}
button.ghost{background:none;color:#99A189;border:1px solid #2C3025}
.err{color:#FF7D92;min-height:1.2em;font-size:.85rem}ul{list-style:none;padding:0}
li{color:#99A189;font-size:.92rem;line-height:1.7}li::before{content:'✓ ';color:#AACF53}
.hide{display:none}</style>
</head><body><main><h1><span class="led">◉</span> oto — ${title}</h1>${body}</main>
<script>${script}</script></body></html>`
}

const loginBody = `
<form id="email-step">
  <p>Sign in to continue. We'll email you a 6-digit code.</p>
  <input id="email" type="email" placeholder="you@example.com" autocomplete="email" required autofocus>
  <button type="submit" id="send">Send code</button>
</form>
<form id="otp-step" class="hide">
  <p>Enter the code we sent to <b id="sent-to"></b>.</p>
  <input id="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autocomplete="one-time-code" required>
  <button type="submit" id="verify">Sign in</button>
</form>
<p class="err" id="err"></p>`

const loginScript = `
const q = location.search.slice(1);
const err = m => document.getElementById('err').textContent = m || '';
const post = (path, body) => fetch(path, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
}).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Request failed'); });
const hint = new URLSearchParams(q).get('login_hint');
if (hint) document.getElementById('email').value = hint;
document.getElementById('email-step').onsubmit = async e => {
  e.preventDefault(); err('');
  const email = document.getElementById('email').value.trim();
  const btn = document.getElementById('send'); btn.disabled = true;
  try {
    await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
    document.getElementById('email-step').classList.add('hide');
    document.getElementById('otp-step').classList.remove('hide');
    document.getElementById('sent-to').textContent = email;
    document.getElementById('otp').focus();
  } catch (ex) { err(ex.message); } finally { btn.disabled = false; }
};
document.getElementById('otp-step').onsubmit = async e => {
  e.preventDefault(); err('');
  const btn = document.getElementById('verify'); btn.disabled = true;
  try {
    await post('/api/auth/sign-in/email-otp', {
      email: document.getElementById('sent-to').textContent,
      otp: document.getElementById('otp').value.trim(),
    });
    // Session cookie is set; resume the OAuth authorize request.
    location.href = '/api/auth/oauth2/authorize?' + q;
  } catch (ex) { err(ex.message || 'Invalid code'); btn.disabled = false; }
};`

const consentBody = `
<p><b id="client"></b> is asking to access your oto account:</p>
<ul id="scopes"></ul>
<div><button id="deny" class="ghost">Deny</button><button id="approve">Approve</button></div>
<p style="font-size:.8rem;opacity:.7"><span id="who"></span>
<a href="#" id="switch" style="color:#99A189">Not you? Switch account</a></p>
<p class="err" id="err"></p>`

const consentScript = `
fetch('/api/auth/get-session').then(r => r.json()).then(s => {
  if (s && s.user) document.getElementById('who').textContent = 'Signed in as ' + s.user.email;
}).catch(() => {});
const params = new URLSearchParams(location.search);
document.getElementById('client').textContent = 'An application';
fetch('/api/auth/oauth2/client/' + encodeURIComponent(params.get('client_id') || '')).then(r => r.json()).then(c => {
  const name = c && (c.name || c.client_name);
  if (name) document.getElementById('client').textContent = name;
}).catch(() => {});
const SCOPE_LABELS = { openid: 'Verify your identity', profile: 'See your profile', email: 'See your email address', offline_access: 'Stay signed in' };
const ul = document.getElementById('scopes');
(params.get('scope') || '').split(' ').filter(Boolean).forEach(s => {
  const li = document.createElement('li'); li.textContent = SCOPE_LABELS[s] || s; ul.appendChild(li);
});
const decide = accept => async () => {
  document.getElementById('err').textContent = '';
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const r = await fetch('/api/auth/oauth2/consent', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ accept, consent_code: params.get('consent_code') }),
    });
    const data = await r.json();
    if (!r.ok || !data.redirectURI) throw new Error(data.error_description || 'Consent failed');
    location.href = data.redirectURI;
  } catch (ex) {
    document.getElementById('err').textContent = ex.message;
    document.querySelectorAll('button').forEach(b => b.disabled = false);
  }
};
document.getElementById('approve').onclick = decide(true);
document.getElementById('deny').onclick = decide(false);
document.getElementById('switch').onclick = async e => {
  e.preventDefault();
  document.getElementById('err').textContent = '';
  try {
    const r = await fetch('/oauth/switch', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ consent_code: params.get('consent_code') }),
    });
    const data = await r.json();
    if (!r.ok || !data.url) throw new Error(data.error || 'Switch failed');
    location.href = data.url;
  } catch (ex) { document.getElementById('err').textContent = ex.message; }
};`

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
    res.type('html').send(page('sign in', loginBody, loginScript))
  })
  router.get(['/consent', '/oauth/consent'], (_req, res) => {
    guard(res)
    res.type('html').send(page('authorize', consentBody, consentScript))
  })
  // "Not you?" — sign the current browser session out and restart the original
  // authorize request. The consent_code is the `identifier` of a Better Auth
  // `verification` row whose JSON value holds the original authorize params:
  // { clientId, redirectURI, scope: string[], userId, authTime, requireConsent,
  //   state, codeChallenge, codeChallengeMethod, nonce }.
  // ponytail: internal Better Auth shape, pinned at better-auth 1.6.26 — re-check on upgrade.
  router.post('/oauth/switch', json(), async (req, res) => {
    try {
      const code = req.body?.consent_code
      const { rows } = typeof code === 'string' && code
        ? await pool.query(
            'select value from verification where identifier = $1 and "expiresAt" > now()',
            [code],
          )
        : { rows: [] }
      if (!rows[0]) {
        res.status(404).json({ error: 'Unknown or expired consent code' })
        return
      }
      const v = JSON.parse(rows[0].value)
      const p = new URLSearchParams({
        client_id: v.clientId,
        redirect_uri: v.redirectURI,
        response_type: 'code',
        scope: Array.isArray(v.scope) ? v.scope.join(' ') : v.scope,
      })
      if (v.state) p.set('state', v.state)
      if (v.codeChallenge) p.set('code_challenge', v.codeChallenge)
      if (v.codeChallengeMethod) p.set('code_challenge_method', v.codeChallengeMethod)
      if (v.nonce) p.set('nonce', v.nonce)
      const { headers } = await auth.api.signOut({
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      })
      for (const cookie of headers.getSetCookie()) res.append('Set-Cookie', cookie)
      res.json({ url: '/api/auth/oauth2/authorize?' + p.toString() })
    } catch {
      res.status(500).json({ error: 'Switch failed' })
    }
  })
  return router
}
