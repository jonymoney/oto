import { Router } from 'express'
import { config } from './config.js'

const url = config.MCP_SERVER_URL
const ASK = `<p class="ask">Now ask: <em>"Read this article aloud with oto."</em></p>`

/** Copyable code field. `id` must be unique per page. */
function copyField(id: string, text: string): string {
  return `<div class="copy"><code id="${id}">${text}</code><button data-copy="${id}">copy</button></div>`
}

const connectHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect — oto</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>
body{margin:0;background:#f4f1ea;color:#16130f;font-family:ui-monospace,'SF Mono',Menlo,monospace}
main{max-width:42rem;margin:0 auto;padding:2.5rem 1.5rem 4rem;line-height:1.65}
.brand{font-size:.95rem;letter-spacing:.04em;margin-bottom:2rem}
.brand a{color:#16130f;text-decoration:none;font-weight:700}.brand a:hover{color:#f5a623}
.led{color:#f5a623}
h1{font-size:1.35rem;margin:0 0 .3rem}
.sub{color:#6f6555;font-size:.85rem;margin:0 0 1.6rem}
p,li{color:#3d372d;font-size:.9rem}
ol{padding-left:1.2rem}ol li{margin-bottom:.35rem}
.copy{display:flex;align-items:stretch;gap:.5rem;margin:.8rem 0 1.2rem}
.copy code{flex:1;min-width:0;background:#fffdf8;border:1px solid #e3dccc;border-radius:8px;
padding:.6rem .8rem;font-size:.82rem;overflow-x:auto;white-space:pre}
.copy button{flex:none;border:1px solid #f5a623;background:#f5a623;color:#16130f;border-radius:8px;
padding:0 .9rem;font-family:inherit;font-size:.8rem;cursor:pointer}
.copy button:hover{background:#fffdf8}
.tabs{margin-top:1.8rem}
.tabs input{display:none}
.tabs label{display:inline-block;padding:.4rem .8rem;margin:0 .3rem .6rem 0;border:1px solid #e3dccc;
border-radius:8px;font-size:.85rem;cursor:pointer;color:#6f6555;background:#fffdf8}
.tab{display:none;border:1px solid #e3dccc;border-radius:12px;background:#fffdf8;padding:1rem 1.2rem}
#t-claude:checked~label[for=t-claude],#t-code:checked~label[for=t-code],
#t-gpt:checked~label[for=t-gpt],#t-cursor:checked~label[for=t-cursor]{
border-color:#f5a623;color:#16130f;font-weight:700}
#t-claude:checked~.tab-claude,#t-code:checked~.tab-code,
#t-gpt:checked~.tab-gpt,#t-cursor:checked~.tab-cursor{display:block}
.ask{color:#6f6555;font-size:.85rem;border-top:1px solid #e3dccc;padding-top:.8rem;margin-bottom:0}
.ask em{color:#16130f;font-style:normal;font-weight:700}
.note{font-size:.8rem;color:#6f6555}
footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid #e3dccc;font-size:.82rem;color:#6f6555}
footer a{color:#16130f;font-weight:700;text-decoration:none;margin-right:1rem}footer a:hover{color:#f5a623}
</style></head><body><main>
<div class="brand"><a href="/"><span class="led">◉</span> oto</a></div>
<h1>Connect oto to your AI</h1>
<p class="sub">One URL works everywhere MCP does.</p>
${copyField('u', url)}
<div class="tabs">
<input type="radio" name="t" id="t-claude" checked>
<input type="radio" name="t" id="t-code">
<input type="radio" name="t" id="t-gpt">
<input type="radio" name="t" id="t-cursor">
<label for="t-claude">Claude</label>
<label for="t-code">Claude Code</label>
<label for="t-gpt">ChatGPT</label>
<label for="t-cursor">Cursor</label>
<div class="tab tab-claude">
<ol>
<li>Open <strong>claude.ai</strong> → Settings → Connectors</li>
<li>Add custom connector</li>
<li>Paste the URL above</li>
<li>Connect, then sign in with your email</li>
</ol>
<p class="note">Works on the Free plan. Once added, the same connector works in Claude Desktop and mobile.</p>
${ASK}
</div>
<div class="tab tab-code">
<ol>
<li>Run:</li>
</ol>
${copyField('cc', `claude mcp add --transport http oto ${url}`)}
<ol start="2">
<li>Then <code>/mcp</code> to sign in</li>
</ol>
${ASK}
</div>
<div class="tab tab-gpt">
<ol>
<li>Settings → Apps → Advanced → enable <strong>Developer mode</strong></li>
<li>Settings → Connectors → Create</li>
<li>Name: <strong>oto</strong>, URL: the one above</li>
<li>Authentication: <strong>OAuth</strong></li>
</ol>
<p class="note">ChatGPT paid plans only, web only.</p>
${ASK}
</div>
<div class="tab tab-cursor">
<ol>
<li>Add to <code>~/.cursor/mcp.json</code>:</li>
</ol>
${copyField('cu', `{"mcpServers":{"oto":{"url":"${url}"}}}`)}
${ASK}
</div>
</div>
<footer><a href="/">Home</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></footer>
</main><script>
document.querySelectorAll('[data-copy]').forEach(function (btn) {
  btn.onclick = function () {
    var el = document.getElementById(btn.dataset.copy);
    var done = function () { btn.textContent = 'copied'; setTimeout(function () { btn.textContent = 'copy'; }, 1500); };
    if (navigator.clipboard) { navigator.clipboard.writeText(el.textContent).then(done); }
    else { var r = document.createRange(); r.selectNodeContents(el);
      var s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); done(); }
  };
});
</script></body></html>`

export function connectRouter(): Router {
  const router = Router()
  router.get('/connect', (_req, res) => {
    res.type('html').send(connectHtml)
  })
  return router
}
