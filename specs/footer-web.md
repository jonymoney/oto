# footer-web — Spec (instantiated for oto)

Instantiated from `blueprint/modules/footer-web.md` on 2026-08-21 into
`public/landing.html`. Parameters below are substituted; no open placeholders.

## Host deviation (recorded at instantiation)

The catalog spec assumes a React client component. oto's landing page is a
static HTML file served from `src/index.ts` — there is no React runtime and no
build step for it. The spec's "Outside the framework" section allows plain CSS
("the spec's classes translate 1:1"), so the **business rules are implemented
verbatim** in vanilla JS/CSS:

| Spec mechanism (React) | oto implementation |
|---|---|
| `useLayoutEffect` + `offsetWidth` | synchronous `getBoundingClientRect()` read before paint |
| `key={place}` to replay entry animation | `document.createElement` + `replaceChildren` (fresh node) |
| `"use client"` | inline `<script>` at end of body |
| unmount clears interval | N/A for a static page — page unload clears it |

One deliberate improvement over the catalog spec: width uses
`Math.ceil(getBoundingClientRect().width)` rather than `offsetWidth`, because
`offsetWidth` rounds down and `overflow:hidden` then shaves up to 0.8px off the
last glyph (measured: 5 of the 16 names were affected).

## Parameters (as instantiated)

| Parameter | Value |
|---|---|
| `PLACES` | Mexico City, Oaxaca, Puerto Escondido, Coyoacán, San Francisco, Seattle, Portland, Bend, Salt Lake City, Yosemite, Big Sur, Zion, Tokyo, Kyoto, Nagano, Furano |
| `LEAD_TEXT` | `Built with ♥ from` (♥ accented) |
| `SECONDARY_LINE` | `© 2026 oto — Anything, read aloud.` |
| `TICK_MS` | `2500` |
| `ACCENT_TOKEN` | `--accent` (moegi 萌黄 — `#7BA428` light / `#AACF53` dark) |
| `NAME_STYLE` | `font-weight:600`, `color: var(--ink)` |

## Business rules (all verified in browser)

- When 2500 ms elapses, advance to the next place, wrapping after Furano. ✓
- When the place changes, the slot's width transitions 300 ms ease-out to the
  incoming name's measured width. ✓ (`transition: width 0.3s ease-out`)
- When a new place enters, its node is recreated so the entry animation
  replays: fade from 0 + rise 6 px, 0.4 s ease. ✓
- When the user prefers reduced motion, the fade/rise is disabled but the width
  transition still runs. ✓ (animation lives only inside
  `@media (prefers-reduced-motion: no-preference)`)
- On first render the slot has no explicit width. ✓ — deviation: the first
  measurement is deferred to `document.fonts.ready`, because measuring against
  a fallback face yields a wrong width. Slot stays `auto` until then.
- No `aria-live` (decorative, per No-goals). ✓ verified: 0 elements.

## Combination with the existing footer

Per the request, the ticker was merged into oto's existing footer rather than
replacing it. Final structure:

- **Top row**: wordmark (via `<use href="#wm">` — the header's SVG paths are
  reused, not duplicated) + the sign-off ticker on the left; nav links
  (How it works, Pricing, Terms, Privacy) on the right.
- **Bottom row**, below a hairline: `© 2026 oto — Anything, read aloud.` and
  `support@oto.audio` (kept visible for Stripe business verification).

The brand's 音 seal is deliberately NOT used here: `docs/brand/BRAND.md`
restricts it to the about screen, share-page watermark, and loading state.

## Integration surface — status

- Component rendered once at end of page body. ✓ done
- `city-in` keyframes added to the page's stylesheet. ✓ done
- Design tokens mapped: `--accent` (♥), `--ink` (name), `--ink-muted`
  (sentence). ✓ done
- Client runtime. ✓ done (inline script)

## Env vars

None.
