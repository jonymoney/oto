# oto — typography research

Researched 2026-08-21. Constraint recap: futuristic-editorial ("magazine from 2035"), morning-radio bright/utilitarian, QUIET numerals (timecodes are metadata), wordmark needs distinctive round o's + interesting t (palindrome "oto", o's as sound shapes), subtle Japanese layer. Banned: Inter-on-white SaaS sameness, retro/heritage faces.

License landscape (verified):
- **Google Fonts / OFL** — free everywhere: web, iOS bundling, modification. No gotchas.
- **Fontshare / ITF Free Font License** — Indian Type Foundry's free platform. Free for personal AND commercial use, including client work, products, websites and applications; restriction is no resale/redistribution of the font files and no derivative fonts ([Fontshare FAQ/license](https://www.fontshare.com/licenses/itf-ffl), [madegooddesigns Fontshare guide](https://madegooddesigns.com/fontshare/)). It is a closed-source license, not OFL — fine to bundle in oto's app/site, but can't be re-hosted or forked.
- **SF Pro** — Apple's license permits use only in software running on Apple platforms; explicitly not usable on the web or Android ([Apple dev forums](https://developer.apple.com/forums/thread/733267), [developer.apple.com/fonts](https://developer.apple.com/fonts/)). Free baseline for the iOS app only; share pages need a different text face.

## Display candidates

### Space Grotesk — Florian Karsten · Google Fonts, OFL · 300–700 + variable
- Proportional redesign of Space Mono; retains mono-derived notches and sheared terminals — the "techy detail" the brief asks for ([floriankarsten.github.io/space-grotesk](https://floriankarsten.github.io/space-grotesk/), [GitHub](https://github.com/floriankarsten/space-grotesk)).
- **o**: near-circular with subtly squared counter; **t**: angled cut on the ascender, abrupt tail — genuinely distinctive at wordmark size. Stylistic sets swap in simpler alternates.
- **Figures**: ships tabular, lining, old-style and proportional figures ([csstypestudio specimen](https://www.csstypestudio.com/library/font/space-grotesk)) — rare for a free display face; timecodes could stay in-family if ever needed.
- **JP fit**: even stroke, low contrast — sits comfortably next to a kaku gothic.
- Evidence: NordVPN, Lemonade, Miro logos/sites ([madegooddesigns](https://madegooddesigns.com/space-grotesk-font/)); Typewolf showcases pair it with editorial serifs (Editorial New, Founders Grotesk) — exactly the futuristic-editorial register ([typewolf.com/space-grotesk](https://www.typewolf.com/space-grotesk)).
- Risk: heavily used in crypto/tech since ~2021; distinctiveness comes from how it's set, not the face alone.

### Clash Display (+ Clash Grotesk) — Indian Type Foundry · Fontshare, ITF-FFL · Extralight–Bold (6) + variable
- Neo-grotesk display with **very small apertures** and visible stroke contrast at joins in heavier weights ([FontBrief](https://www.fontbrief.com/fonts/clash-display), [Freebiesbug](https://freebiesbug.com/free-fonts/clash-display/)). "Eye-catching with enough restraint for corporate and editorial use" — closest single face to "magazine from 2035."
- **o**: tight, almost-closing round bowl — reads as a speaker cone / sound aperture, strong for the o-t-o wordmark; **t**: short blunt ascender, crisp crossbar.
- **Figures**: display-tuned; tabular figures not documented — keep numerals out of it (which the brief wants anyway).
- **Clash Grotesk** is the matching text-friendly sibling on Fontshare if a one-family system is wanted ([fontshare.com/fonts/clash-grotesk](https://www.fontshare.com/fonts/clash-grotesk)).
- **JP fit**: tight apertures vs. open kana counters is a real contrast — works if JP is a small accent (音 glyph, captions), not running text.
- Evidence: dedicated Fonts In Use page with live sites ([fontsinuse.com/typefaces/166084](https://fontsinuse.com/typefaces/166084/clash-display)); a staple of current indie-editorial web design ([onepagelove showcase](https://onepagelove.com/typeface/clash-display)).
- Risk: also trending; and ITF-FFL means no modified/custom-cut wordmark derived from the font files.

### Cabinet Grotesk — ITF · Fontshare, ITF-FFL · Thin–Black (8) + variable
- Display grotesk, 8 weights, variable ([Freebiesbug](https://freebiesbug.com/free-fonts/cabinet-grotesk/), [Fonts In Use](https://fontsinuse.com/typefaces/155454/cabinet-grotesk)). Warmer/quirkier than Clash — more "friendly magazine" than "2035." Solid backup, not the lead.

### General Sans — ITF · Fontshare, ITF-FFL · Extralight–Bold + italics + variable
- Deliberately neutral; handles display and text ([Fontshare](https://www.fontshare.com/?categories=Sans)). Too anonymous for the wordmark — risks the banned "SaaS sameness." Useful only as an all-purpose fallback.

### Unbounded — NaN / Studio Koto / Parity · Google Fonts, OFL · 200–900 variable
- Community-funded Polkadot brand face ([nan.xyz/fonts/unbounded](https://www.nan.xyz/fonts/unbounded/), [Google Fonts](https://fonts.google.com/specimen/Unbounded)). Ultra-wide, rounded, unmistakably futuristic; the widest, roundest o's of any candidate — literal "sound shapes."
- Risk: it IS the Polkadot identity; strong web3 scent. Viable only as a wordmark-only stunt, and even then borrowed-identity risk is high. Not recommended as system display.

### Zodiak — ITF · Fontshare
- High-contrast display **serif**; reads fashion-editorial/heritage. Conflicts with "modern geometric letterforms" and the retro/heritage ban. **Rejected.**

## UI / text companions

### SF Pro (iOS baseline) — Apple · free on Apple platforms ONLY
- Best small-size rendering on iOS (optical sizes, Dynamic Type). Quiet timecodes for free: `.monospacedDigit()` gives tabular figures natively. Zero download weight. Cannot appear on web share pages (license).

### Instrument Sans — Rodrigo Fuenzalida for Instrument · Google Fonts, OFL · variable (wght + wdth), italics
- Precise-but-warm sans, **width axis** (useful for tight metadata rows), **tabular figures confirmed**, 12 stylistic sets ([Google Fonts](https://fonts.google.com/specimen/Instrument+Sans), [GitHub](https://github.com/Instrument/instrument-sans)). Own Fonts In Use page ([fontsinuse](https://fontsinuse.com/typefaces/219916/instrument-sans)). Geometric enough to echo the display face without being Inter. Best free web-text candidate.

### Geist — Vercel + Basement Studio · OFL · 100–900 variable
- Engineering-grade; supports `tnum` + slashed zero — Vercel's own system uses tabular numerals for metrics/logs ([designsystems.one breakdown](https://www.designsystems.one/design-systems/vercel-geist), [vercel.com/font](https://vercel.com/font)). **Caveat**: the Google Fonts build strips some OT features — self-host from [vercel/geist-font](https://github.com/vercel/geist-font) to keep `tnum` ([lexingtonthemes guide](https://lexingtonthemes.com/blog/geist-opentype-features)). Risk: strongly "Vercel dev-tool" flavored — pulls toward the banned SaaS look unless art-directed hard.

### Figtree — Erik Kennedy · Google Fonts, OFL · 300–900 variable + italics
- Friendly geometric sans, 280+ languages ([erikdkennedy.com/projects/figtree](https://www.erikdkennedy.com/projects/figtree.html)). Tabular figures not documented — weaker for timecodes. Warmer/rounder than the brief's editorial edge. Backup only.

## Japanese companion (if 音 ever appears)

- **Zen Kaku Gothic New** — Google Fonts, OFL, 5 weights (300/400/500/700/900), no variable. "Square gothic": geometric, even, upright — visually the best match for Clash/Space Grotesk's geometry ([Google Fonts](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New), [googlefonts/zen-kakugothic](https://github.com/googlefonts/zen-kakugothic)). First choice.
- **Noto Sans JP** — OFL, variable, exhaustive coverage; more neutral/soft than Zen Kaku. Use as fallback in the stack: `"Zen Kaku Gothic New", "Noto Sans JP", sans-serif`.

## What futuristic-editorial brands actually use

- Space Grotesk in the wild: NordVPN, Lemonade, Miro; Typewolf-featured sites pair it with **Editorial New** (Pangram Pangram) and Söhne-class grotesks — the "modern editorial serif + techy grotesk" formula ([typewolf.com/space-grotesk](https://www.typewolf.com/space-grotesk)).
- Clash Display carries the indie-editorial web (Fonts In Use + One Page Love showcases above).
- Unbounded = Polkadot's entire identity (Koto/NaN/Parity) — proof that a wide-round geometric display reads "future" ([polkadot press release](https://polkadot.com/newsroom/press-releases/web3-foundation-launches-unbounded-a-world-first-in-community-funded-typographic-fonts/)).
- Vercel/Geist demonstrates the "quiet tabular numerals as engineering voice" move oto wants for timecodes ([designsystems.one](https://www.designsystems.one/design-systems/vercel-geist)).
- The paid tier real 2035-magazine brands buy: PP Neue Montreal / Editorial New (Pangram Pangram), Monument Grotesk (ABC Dinamo). Clash Display + Space Grotesk are the honest free stand-ins, not imitations.

## Implications for oto

Rule that satisfies "quiet numerals" in every pairing: **timecodes always in the UI/text face at small size with tabular figures** (SF Pro `.monospacedDigit()` on iOS; `font-variant-numeric: tabular-nums` on web) — never in the display face. Display faces need no figures at all.

1. **Recommended: Clash Display + SF Pro (iOS) / Instrument Sans (web)**
   Clash Display (Medium–Semibold) for wordmark, headlines, empty-state editorial lines; its tight-aperture o's are the "sound shape" and the palindrome sets symmetrically. SF Pro for all iOS UI (free, native, tabular digits). Instrument Sans variable (self-host or Google Fonts) on share pages — geometric kinship without Inter sameness. JP: Zen Kaku Gothic New.
   License: Clash = ITF-FFL (free commercial, bundling OK, no font-file modification); Instrument Sans = OFL; SF Pro = iOS only.

2. **All-OFL alternative: Space Grotesk + SF Pro (iOS) / Geist self-hosted (web)**
   Techier, more "morning radio utility"; Space Grotesk's sheared-t is a strong wordmark hook and it owns real tabular figures. Everything modifiable (OFL) — matters if the wordmark becomes a customized cut. Risk: most-seen combo in tech; needs strong color/layout to avoid sameness.

3. **Wordmark-stunt option: Unbounded (wordmark only) + Instrument Sans system-wide**
   Maximum sound-shape o's; OFL so the logo can be customized from it. Keep Unbounded off everything except the mark to dodge the Polkadot association. Lowest recommendation — evaluate against pairing 1 in the direction round.

Not advanced: General Sans (too neutral), Figtree (too soft, tnum unverified), Cabinet Grotesk (warm-quirky, off-brief), Zodiak (heritage-serif, banned).
