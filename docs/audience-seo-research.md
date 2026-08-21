# oto — audience & SEO research (2026-08-21)

Agent-researched report grounding the landing-page positioning. Summary of findings;
the landing page (`public/landing.html`) implements the messaging hierarchy below.

## Personas (ranked)

1. **AI power-user / curious learner** (founder persona) — asks Claude/ChatGPT things all
   day, wants answers listenable on walks/commutes. **No incumbent serves "audio of AI
   conversations"** — ChatGPT Read Aloud is ephemeral; Claude TTS MCP servers are dev toys.
   Reachable free via MCP directories, r/ClaudeAI, HN. Lead with this.
2. **ADHD / dyslexia / auditory-preference readers** — loudest demand signal in the
   category; every competitor markets to them ("I have ADHD… Eleven Reader saved me").
   High willingness to pay, heavily contested. Secondary section, not the hero.
3. **Students** — "listen to textbooks at the gym / while cleaning". Speechify's camera/PDF
   import beats chat-paste today. Hold until iOS ships.
4. **Read-it-later refugees** — Pocket (and its Listen feature) died July 2025; Matter
   ($60/yr) and Readwise ($9.99/mo) are the fallbacks. "Turn my newsletter backlog into
   a podcast." Wave of micro "article→podcast" apps proves demand.
5. Language learners — diffuse, price-sensitive. Skip.

## Competitor gaps

| Competitor | Pricing | Gap oto owns |
|---|---|---|
| ElevenReader | free 10h/mo; $11/mo | no sharing, no feed, not chat-native |
| Speechify | $139/yr | billing-complaint trust deficit; no permanence |
| NotebookLM Audio Overviews | free-ish | summarizes, doesn't read verbatim; audio trapped in notebooks |
| Matter / Readwise | $60/yr / $9.99/mo | article-save only; can't voice AI answers or notes |
| Curio/Audm | dead | curated-content audio didn't survive; UGC audio has no licensing cost |

Composite gap: **everyone converts; nobody keeps and shares.** Chat-native generation +
forever library + no-account share pages + explore feed together are unowned.
Closest frame: "NotebookLM meets a podcast app."

## Keywords

Winnable now: "claude text to speech" / "claude read aloud" / "listen to claude responses";
"mcp text to speech" (+ get listed in MCP directories: mcpservers.org, lobehub);
"turn article into podcast"; "text to podcast"; "make an audiobook from text";
"listen to chatgpt answers"; "pocket listen alternative".

Worth dedicated pages later: "speechify alternative" (billing-complaint hook),
"listen to articles app", "pdf to audiobook" (needs a free web converter as lead magnet).
First two expansion pages: `/vs/speechify`, `/listen-to-articles`.

Not winnable: "text to speech" (409K/mo, NaturalReaders/Speechify), "podcast",
"ai podcast generator", "read aloud app".

Schema: SoftwareApplication + FAQPage on the homepage (done); **AudioObject on share
pages + a transcript excerpt** — share pages are the sleeper SEO asset: every published
audio is an indexable page ranking for the content's own keywords. (TODO in share.ts)

## Messaging hierarchy (implemented)

H1 "Turn anything into audio you keep forever." — no MCP/TTS/connector jargon above the
fold; visitors say *listen, read aloud, podcast, audiobook*. Section order = visitor's
question order: hero+playable demo → how it works (3 steps) → use-case cards (personas
in their words) → why-oto (forever library / share / feed) → voices+pricing → FAQ.

Warning from the evidence: Curio/Audm prove a beautiful audio-consumption app alone
doesn't retain; NotebookLM proves the pull is "MY content, made listenable." Anchor
every message on the user's own content/curiosity — the explore feed is a bonus,
never the pitch.
