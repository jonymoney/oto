# TODOs for Jonathan

Canonical URL is now **https://oto.audio** (custom domain, TLS live). Dashboard-only
steps I can't reach are below.

## Required to finish the login flow

1. **Supabase → Authentication → URL Configuration → Site URL**
   → `https://oto.audio`
   Supabase's OAuth server sends users to `<Site URL>/oauth/consent`; until set,
   sign-in dead-ends.

2. **Same page → Redirect URLs** → add `https://oto.audio/oauth/consent`
   Lets email-confirmation links return the user straight into the consent step
   (the page now passes `emailRedirectTo` with the exact consent URL).

3. **Supabase → Authentication → Emails → SMTP Settings** — enable custom SMTP:
   - Host `smtp.resend.com` · Port `465` · Username `resend`
   - Password: your Resend API key
   - Sender: `auth@oto.audio` (works once Resend shows the domain **Verified** —
     your DNS records are correct: send MX/SPF + DKIM all present)
   Keep **Confirm email ON** once SMTP works.

4. **Claude connector** — delete the old connector
   (`oto-server-production.up.railway.app/mcp`) and re-add with:
   `https://oto.audio/mcp`
   The OAuth resource identity now points at oto.audio, so the old URL won't
   pass metadata validation anymore.

## Optional / later

5. **DMARC** — add TXT `_dmarc.oto.audio` → `v=DMARC1; p=none;` (deliverability;
   Resend recommends it).
6. **Bucket rename** — after ~2026-06-14: `railway bucket rename -b versatile-shoebox-SbVt -n oto-audio`,
   then update the `${{...}}` references on `oto-server`.
7. **OpenAI key hygiene** — key was pasted in chat during setup; rotate at
   platform.openai.com, then `railway variables -s oto-server --set "OPENAI_API_KEY=<new>"`.
8. **Spending guard** — monthly budget cap on the OpenAI project (TTS ≈ $0.015/min).

## Done (no action)

- ✅ oto.audio on Railway with TLS; Resend DNS (MX/SPF/DKIM) correct
- ✅ `MCP_SERVER_URL=https://oto.audio/mcp` set; landing page on `/`
- ✅ OpenAI key set; Supabase OAuth Server + Dynamic Apps on; path `/oauth/consent`; ES256
- ✅ Railway: Postgres, bucket (iad), oto-server + domains + env vars
- ✅ E2E verified: generate → store → presign → fetch → dedup; OAuth 401 challenge correct
- ✅ Adversarial review: 20 confirmed findings fixed (server + UI)
- ✅ Vortex easter egg deployed — say "Open the oto vortex" in Claude, or tap ◉ oto 5×
