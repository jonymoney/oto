# Color

Source of truth: [tokens.json](../tokens.json) → `node scripts/gen-swift.mjs` →
`ios/Sources/Theme.swift`. Never hardcode a hex in app code.

## Chrome (light / dark twins — equal pair, neither derived)

| Token | Name | Light | Dark |
|---|---|---|---|
| ground | byakuroku 白緑 | `#F4F7EE` | `#181A13` |
| surface_1 | gofun 胡粉 | `#FAFCF5` | `#1F221A` |
| surface_2 | shironeri 白練 | `#FFFFFF` | `#262A20` |
| ink | shikkoku 漆黒 | `#181A13` | `#EEF1E5` |
| ink_muted | rikyūnezu 利休鼠 | `#6D7561` | `#99A189` |
| ink_faint | — | `#8F977F` | `#6F7663` |
| hairline | — | `#DDE3D1` | `#2C3025` |
| accent | moegi 萌黄 | `#7BA428` | `#AACF53` |
| accent_text | moegi | `#5C7D1E` | `#AACF53` |
| error | kurenai 紅 | `#C22645` | `#FF7D92` |

## Voice colors

One canonical anchor per voice (tokens.json `voice`). Rules:
- Never alone — initial glyph or name rides along.
- Text on voice-tinted grounds is always paper/ink tokens, never raw tint.
- sage = moegi is deliberate (house voice). shimmer is the only iridescent.
- yamabuki `#F8B500` is reserved — not an accent, not a voice.

## Gradients

Tonal only (one hue, lightness ramp). Cross-hue: liquid orbs + shimmer only.
