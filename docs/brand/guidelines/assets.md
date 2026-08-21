# Assets & pipeline

- `docs/brand/tokens.json` — **single source of truth** (snake_case). Palette,
  voice anchors, type, rules.
- `scripts/gen-swift.mjs` — codegen: tokens.json → `ios/Sources/Theme.swift`
  (same `Theme.*` API the app already uses, plus `Theme.voiceAnchor(_:)`).
  Run after any token change: `node scripts/gen-swift.mjs`.
- `docs/brand/logo/` — outlined SVGs + 1024 PNG. Regenerate via the
  brand-session script (fontTools; letters are paths, no installed fonts
  needed).
- **Fonts to bundle in the iOS app** (when the UI adopts the identity):
  ClashDisplay-Semibold from fontshare.com (ITF-FFL — bundling allowed, don't
  modify/redistribute the files). Zen Kaku Gothic New Medium from Google Fonts
  (OFL) if the 音 seal ships in-app.
- **Cover system**: generated server-side — voice anchor ground, Clash Display
  title (max 3 lines), paper wordmark + dot, kanji color-name + romaji +
  duration line. See review-phase4.html for the reference render.
- **Chimes**: build on A440→A880 (see BRAND.md quiet layer).

Review pages (archived per phase): review-phase2/25/3/4.html; `review.html` is
always the latest. Published artifact (same URL across phases):
https://claude.ai/code/artifact/cdcc91d6-e107-4186-af75-cdfad66ee2a9
