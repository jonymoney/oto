# footer-web — Handoff

Generated 2026-08-21. Spec: `specs/footer-web.md`. Target: `public/landing.html`.

## Env vars

None. The module declares no env vars, so nothing was added to config and
nothing needs setting locally or on Railway.

## Integration steps still pending

1. **Curate `PLACES`.** The list was taken from the catalog spec's example,
   which was extracted from the author's own site — verify it still reflects
   where you want the sign-off to name. Editing the constant in the ticker
   script is a content change, not a regeneration.
2. **Nothing else.** The module is a leaf: no events, no endpoints, no consumer
   code to wire up.

## Verification

Live in the local preview (`landing-preview`, port 8124). Verified in-browser:

- transition computed as `width 0.3s ease-out`; entry animation `city-in 0.4s`
- measurer's font family/size/weight identical to the slot (correct widths)
- measurer `visibility:hidden` + `aria-hidden="true"`; zero `aria-live` nodes
- widths differ per name (Zion 31px → Puerto Escondido 123px) and every
  assigned width now has sub-pixel slack, so no glyph clips at rest
- footer wordmark renders through `<use href="#wm">` (62.5px wide)
- light, dark, and 375px mobile all check out

To smoke-test after deploy:

```bash
curl -s https://oto.audio/ | grep -c 'placeSlot'
```

Then load https://oto.audio/ and watch the footer for ~10s: the place name
should change every 2.5s, with the sentence's spacing staying constant and each
name fading up from below.

## Defects found and fixed during generation

- **ASI hazard**: the new IIFE followed the existing voice-preview IIFE with no
  separating semicolon, so `})()` + `(function` parsed as a call and threw a
  TypeError — the ticker never ran (the voice chips still worked, which is why
  it was not obvious). Fixed by terminating the preceding IIFE.
- **Sub-pixel clipping**: `offsetWidth` (the mechanism the catalog spec names)
  rounds down; `overflow:hidden` then shaved up to 0.8px off the last glyph on
  5 of the 16 names. Switched to `Math.ceil(getBoundingClientRect().width)`.
  Worth folding back into the catalog spec.
- **Font-load race**: measuring before Clash Display / Instrument Sans load
  gives fallback-face widths. First measurement now waits on
  `document.fonts.ready`.
