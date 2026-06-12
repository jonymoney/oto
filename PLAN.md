# oto — lightweight plan

Findings from the stack investigation (June 2026), the decisions taken, and the build order.
All load-bearing facts below were verified against official docs by independent fact-checkers.

## Architecture

```
MCP host (Claude web/Desktop, ChatGPT)
   │  Streamable HTTP + OAuth 2.1 Bearer token
   ▼
┌─────────────────────────────── Railway project: OTO MCP APP ──┐
│  oto service (Node 20+ / TypeScript / Express)                │
│   ├── POST /mcp                MCP server (tools + ui:// res) │
│   ├── /.well-known/...        OAuth protected-resource meta   │
│   ├── /consent                Supabase OAuth consent page     │
│   └── /health                 healthcheck                     │
│  Postgres                      audio history metadata         │
│  Storage Bucket (S3-compat)    mp3 files, presigned GET URLs  │
└───────────────────────────────────────────────────────────────┘
   │ verify JWT via JWKS                │ generate audio
   ▼                                    ▼
Supabase Auth (OAuth 2.1 server)     OpenAI TTS API
(auth ONLY — no app data)            (gpt-4o-mini-tts)
```

## Verified stack decisions

### MCP app (UI in the chat)
- **MCP Apps is now an official MCP extension** (first official extension, released 2026-01-26; OpenAI Apps SDK and community mcp-ui converged into it). One codebase targets both Claude and ChatGPT.
- Packages: `@modelcontextprotocol/sdk@^1.29.0` + `@modelcontextprotocol/ext-apps@^1.7.4` (stay on SDK 1.x — v2 is alpha). UI: React, bundled to a **single HTML file** (`vite` + `vite-plugin-singlefile`), registered as a `ui://oto/player.html` resource with MIME `text/html;profile=mcp-app`.
- Tools: `text_to_speech` (model-visible, renders the player via `_meta.ui.resourceUri`) and `list_history` (+ UI-only helper tools with `_meta.ui.visibility: ["app"]` for pagination/replay).
- Audio playback in the iframe: works via `<audio>`; **declare the bucket origin `https://storage.railway.app` in `_meta.ui.csp.resourceDomains`** (CSP is deny-by-default). Autoplay with sound is blocked — playback starts from the user's click.
- Don't put audio bytes in the tool result the model sees — return a short text summary in `content[]` and `{audioUrl, id, title, durationSec}` in `structuredContent` for the UI.
- Reference implementation: the official `ext-apps` repo's `examples/say-server` is literally a TTS audio-player app.
- Caveat: Claude had iframe-rendering bugs as of May–June 2026 — smoke-test rendering in Claude early; serve fully-bundled HTML (no dev-server script tags).

### OpenAI TTS
- Model: **`gpt-4o-mini-tts`** (current snapshot 2025-12-15). Pricing: $0.60/1M input tokens + $12/1M audio tokens ≈ **$0.015 per minute of audio**.
- `POST /v1/audio/speech` via `openai` npm v6.x (Node 20+). Output format: **mp3** (universal `<audio>` support; opus breaks Safari).
- 13 voices (default: `coral`); optional `instructions` param steers tone/pacing (gpt-4o-mini-tts only).
- Limits: 4096 chars AND 2000 tokens per request → chunk long texts on sentence boundaries (~3800 chars), concatenate server-side.
- No streaming needed — we generate once, store, then play from storage.

### Auth (Supabase, auth only)
- **Supabase Auth acts directly as the OAuth 2.1 authorization server** — its OAuth Server feature (beta, free) supports the full MCP handshake Claude performs: RFC 8414 discovery, dynamic client registration, PKCE, refresh tokens. No proxy auth server needed.
- The oto server is the OAuth *resource server*: serve RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource` with `authorization_servers: ["https://rzkoyjmzmpigcvxfdhmc.supabase.co/auth/v1"]`, return 401 + `WWW-Authenticate`, and verify Bearer JWTs statelessly against Supabase's JWKS (`jose`), checking `iss` + `exp`; `sub` = user id for history rows. SDK 1.29 ships `requireBearerAuth` middleware + metadata router.
- Setup required in Supabase dashboard: enable **Authentication → OAuth Server** + dynamic client registration, and **migrate JWT signing keys to asymmetric (ES256)** — JWKS validation fails on legacy HS256.
- **We must build the consent page ourselves** (Supabase doesn't host one) — small page on the oto service using `supabase.auth.oauth.getAuthorizationDetails / approveAuthorization / denyAuthorization`.
- Known gap: Supabase ignores RFC 8707 `resource` indicators (tokens carry `aud:"authenticated"`). Acceptable since this Supabase project is dedicated to oto; can harden later with a Custom Access Token Hook.

### Railway (hosting + DB + storage)
- **Railway Storage Buckets are GA and S3-compatible** — no external provider needed. $0.015/GB-month, **free API ops and free egress (including presigned URLs)**. Private-only: serve audio via **short-lived presigned GET URLs** (AWS SDK v3 `S3Client` with `endpoint: https://storage.railway.app`).
- Postgres: provision in-project; app consumes `DATABASE_URL=${{Postgres.DATABASE_URL}}` (private network). Small `pg.Pool` (5–10 conns) is plenty.
- Deploy: Railpack builder + `railway.json` (`healthcheckPath: /health`, `restartPolicyType: ON_FAILURE`), bind `0.0.0.0:$PORT`, generate a `*.up.railway.app` HTTPS domain.
- Edge limits: 15-min max request, 60s keep-alive — send SSE keep-alive comments every ~20s on long-lived streams; normal tool calls unaffected.
- Don't copy Railway's own MCP guide (it shows the deprecated HTTP+SSE transport) — use Streamable HTTP.

## Data model (Postgres)

```sql
audios (
  id           uuid pk,
  user_id      uuid          not null,  -- Supabase auth `sub` claim
  text_hash    text          not null,  -- sha256(text + voice + model + format) → dedup
  text         text          not null,
  voice        text          not null,
  model        text          not null,
  format       text          not null default 'mp3',
  object_key   text          not null,  -- bucket key: audio/<user_id>/<text_hash>.mp3
  duration_sec numeric,
  char_count   int,
  created_at   timestamptz   default now(),
  unique (user_id, text_hash)           -- generate once, never twice
)
```

`text_to_speech` flow: hash input → if `(user_id, text_hash)` exists, return stored audio (presigned URL) — **no OpenAI call**; otherwise generate, upload to bucket, insert row, return presigned URL.

## Build order

1. **Scaffold** — TypeScript project, pinned deps, `railway.json`, `.env` wiring. ✅ env files done
2. **Core services** — OpenAI TTS client (chunking), S3 storage client (upload + presign), Postgres repo (dedup lookup).
3. **MCP server** — Express + Streamable HTTP `/mcp`, `text_to_speech` + `list_history` tools, no auth yet; test with `examples/basic-host` / MCP inspector.
4. **UI** — React player + history browser, single-file bundle, `ui://` resource, CSP domains; smoke-test rendering in Claude via cloudflared tunnel (custom connector — needs paid Claude plan).
5. **Auth** — Supabase OAuth server config (dashboard), PRM endpoint, JWKS Bearer validation, consent page.
6. **Provision + deploy** — Railway: Postgres + bucket + service in `OTO MCP APP` (id `f37e3203-2790-4119-80da-cdaa91c45afc`), reference variables, domain; run migration; end-to-end test from Claude.

## Needs from Jonathan

- [x] OpenAI API key in `.env` (validated against the API 2026-06-12)
- [x] Supabase: OAuth Server enabled (2026-06-12) — verify dynamic client registration is also toggled on
- [x] Supabase: JWT signing keys — already ES256 (verified via JWKS endpoint 2026-06-12; new projects default to asymmetric keys, no migration needed)
- [ ] A paid Claude plan to add the custom connector for testing (Pro/Max/Team)
