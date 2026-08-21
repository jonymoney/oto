# Color research: a voice-mapped color family for oto

Philosophy under test: a small set of vivid colors where **each color means a specific TTS voice**.
Base: true light + true dark as an equal pair. Register: morning-radio bright, futuristic-editorial,
subtle Japanese layer. Banned: purple-blue AI gradients, corporate SaaS blue.

---

## 1. Precedents — color mapped to entities, not decoration

**Tokyo Metro line colors (1970– )** — the closest structural precedent: ~9 lines, each with one
canonical color derived originally from train body colors (Ginza orange, Marunouchi red, Tōzai sky
blue, Chiyoda green, Hanzōmon purple, Hibiya silver). Two lessons: (a) *recognition over recall* —
the color repeats identically on every touchpoint (map, signage, train, ticket) until it becomes
the line's name; (b) color is **never alone** — it always co-occurs with a letter code (G, M, T…),
which is both the a11y escape hatch and half the graphic identity.
Sources: [Get Around Japan](https://www.getaroundjapan.jp/archives/8683), [Golden Design Lessons from Tokyo Metro](https://medium.com/@linhng1103/golden-design-lessons-from-the-tokyo-metro-system-765f1cc7e045), [Wikipedia line symbol template](https://en.wikipedia.org/wiki/Template:Tokyo_Subway_Line_Symbol)

**Spotify × Collins (2015)** — expanded green+black to a 31-color palette applied as **duotone**:
any photo becomes on-brand by mapping it to two colors, automated by an internal tool ("the
Colorizer"). Lesson for oto: one voice hue + the shared paper/ink neutral is enough to make any
generated artwork or share page read as branded — build the tint programmatically, don't hand-art it.
Sources: [Design Week](https://www.designweek.co.uk/issues/9-15-march-2015/spotify-undergoes-colourful-brand-refresh/), [COLLINS case study](https://wearecollins.com/case-studies/spotify/), [Brand New](https://www.underconsideration.com/brandnew/archives/new_identity_for_spotify_by_collins.php)

**Apple Music adaptive tinting (iOS 26.4)** — full-screen backgrounds derived from the playing
artwork (layered, blur-shaded copies, not sampled swatches). Immersive, but drew legibility
complaints when tinted grounds sat under text. Lesson: content-derived tint is powerful for the
*player moment*, but text must sit on graded tokens, never raw tint.
Sources: [9to5Mac](https://9to5mac.com/2026/03/31/the-new-adaptive-apple-music-design-draws-complaints-from-dark-mode-users/), [Reverse-engineering the gradient](https://www.aadishv.dev/music)

**Porsche Paint to Sample / heritage colors** — colors as *named nouns* with biographies: Signal
Green, Rubystone Red, Mexico Blue, Guards Red. The name is what makes the color ownable and
merchandisable. Lesson: a hex is decoration; a **named** hex is identity. This is the strongest
argument for Japanese color names in oto.
Sources: [Porsche Newsroom PTS](https://newsroom.porsche.com/en_US/2021/products/porsche-models-comeback-historic-colors-paint-to-sample-options-26548.html), [PTS Explorer](https://www.ptsexplorer.com/)

**Teenage Engineering Pocket Operators** — a product family unified by identical form factor,
differentiated by color + function pairing (POM 400 "the big yellow one"). Color becomes the casual
name users reach for. Sources: [teenage.engineering/products/po](https://teenage.engineering/products/po), [Constraints as Aesthetic](https://blakecrosley.com/guides/design/teenage-engineering)

**Google's four colors** — blue/red/yellow/green repeat across product icons so the *combination*
signals "Google" even without a wordmark; individual colors also carry state semantics (blue link,
red error…). Cautionary lesson: when every entity gets the same four colors, colors stop
distinguishing entities — oto should keep **one hue per voice**, not one palette per surface.
Sources: [colorcode.tools/brands/google](https://colorcode.tools/brands/google), [Why the Google logo is multicolored](https://colorindicator.com/academy/why-google-logo-is-multicolored)

---

## 2. Japanese traditional color candidates (日本の伝統色)

Dentōshoku names derive from dye plants, minerals, animals and court-rank cloth traditions going
back ~1,400 years — a color is meaningful through its *source*, which matches oto's voice-as-persona
framing. Hexes below are the canonical values from the 和色大辞典 ([colordic.org/w](https://www.colordic.org/w)); cross-checked
against [Wikipedia's Traditional colors of Japan](https://en.wikipedia.org/wiki/Traditional_colors_of_Japan) and [ColorFYI](https://colorfyi.com/blog/japanese-traditional-colors/).

| Name | Kanji | Meaning / source | Hex |
|---|---|---|---|
| shu | 朱 | vermilion — cinnabar, shrine gates, teacher's ink | `#EB6101` |
| hi | 緋 | scarlet — "flame red", court robes | `#D3381C` |
| akane | 茜 | madder red — dusk-sky red from madder root | `#B7282E` |
| kurenai | 紅 | crimson — safflower ceremonial red | `#D7003A` |
| suō | 蘇芳 | sappanwood — muted rose-burgundy | `#9E3D3F` |
| tsutsuji | 躑躅 | azalea — hot pink-magenta | `#E95295` |
| sakura | 桜 | cherry blossom — near-white pink | `#FEF4F4` |
| yamabuki | 山吹 | kerria rose — vivid golden yellow | `#F8B500` |
| kincha | 金茶 | golden brown — gilded tea | `#F39800` |
| kohaku | 琥珀 | amber — fossil resin | `#BF783A` |
| moegi | 萌黄 | sprout green — new spring growth | `#AACF53` |
| wakakusa | 若草 | young grass | `#C3D825` |
| tokiwa | 常磐 | evergreen — "eternal rock" pine | `#007B43` |
| seiji | 青磁 | celadon — pale gray-green glaze | `#819C8B` |
| asagi | 浅葱 | pale scallion — the vivid Shinsengumi teal | `#00A3AF` |
| konpeki | 紺碧 | azure — deep sky over sea | `#007BBB` |
| ruri | 瑠璃 | lapis lazuli — jewel blue | `#1E50A2` |
| ai | 藍 | indigo — "Japan blue", dye vats | `#004C71` |
| kikyō | 桔梗 | bellflower — cool violet | `#5654A2` |
| edo-murasaki | 江戸紫 | Edo purple — kabuki headband purple | `#745399` |
| ginnezu | 銀鼠 | silver mouse — refined Edo gray | `#AFAFB0` |
| sumi | 墨 | ink — calligraphy ink black | `#595857` |
| tamamushi | 玉虫 | jewel beetle — *iridescent by definition* | (shifts) |

Note how well this set already rhymes with oto: Theme.swift's amber accent (`#E08600`/`#FFB02E`)
**is** yamabuki/kincha territory, and the paper/ink neutrals are washi + sumi. The Japanese layer is
already latent in the app.

---

## 3. Craft: one canonical hue per voice, vivid on both grounds

- **Anchor hue, grade lightness.** Define each voice color once in OKLCH as a canonical *hue* (H)
  with a target chroma, then derive per-mode tones by moving only L (and clamping C). Hue must stay
  fixed across modes — a hue shift reads as a different identity; an L shift reads as the same
  color under different light. OKLCH makes this safe because equal L steps are perceptually equal
  across hues, unlike HSL. ([LogRocket OKLCH guide](https://blog.logrocket.com/oklch-css-consistent-accessible-color-palettes), [Luminance-first color systems](https://www.boldvanta.com/design/designing-luminance-cefirst-color-systems-with-oklch-tokens-ramps-and-real-ceworld-pitfalls.html))
- **Normalize the family.** Snap every voice's solid to a shared lightness band per mode — e.g.
  light-mode solids L ≈ 0.55–0.62, dark-mode solids L ≈ 0.70–0.78, C ≈ 0.12–0.18 — so 16 hues feel
  like one system instead of 16 opinions. This is the Radix Colors move: same step = same UI role
  across every scale, light and dark. ([Radix Colors](https://www.radix-ui.com/colors), [Radix color docs](https://www.radix-ui.com/themes/docs/theme/color))
- **Two tones per mode (four tokens per voice).** Minimum viable set, matching Theme.swift's
  existing `dynamic(light:dark:)` pattern:
  `voice.solid` (fills: orb core, progress bar, chips — ≥3:1 vs ground, WCAG non-text) and
  `voice.text` (text/icons/strokes — ≥4.5:1 or APCA Lc 60). On paper, text-grade is darker than
  solid; on dark ground it's lighter. Radix steps 9 (solid) and 11 (text) are exactly this.
- **Problem children.** Yellows (yamabuki) can't reach text contrast on paper at full chroma —
  the text-grade leans brown (kincha), the way transit maps outline yellow lines. Near-neutrals
  (sumi, ginnezu) differentiate by L inversion, not chroma. High-chroma teal/green will clip sRGB
  gamut at high L — clamp C per hue rather than dulling the whole family.
- **Never color alone.** Pair every voice color with a second channel: the voice's initial glyph
  (Tokyo Metro's letter), name label, or orb shape. This covers color-blind users and doubles as
  the futuristic-editorial typographic layer.
- **Tint the moment, not the text.** Voice-tinted washes (player background, share page) follow
  Apple Music's playbook but keep text on graded ink/paper tokens — the exact failure Apple shipped.

---

## 4. Implications for oto

**Distill, don't restart.** OrbPalettes.swift already spreads 17 voices across the wheel with
distinct, characterful hues. The move: collapse each 3-color orb palette to **one canonical hue**,
then snap that hue to the nearest traditional color name and re-grade L/C in OKLCH per §3. Orbs keep
their multi-tone liquid palettes (the *expression*); the canonical hue becomes the token used
everywhere else (player progress, history rows, NEW badges, share pages, artwork duotones).

Proposed mapping (orb dominant → dentōshoku anchor):

| Voice | Anchor | Hex | Voice | Anchor | Hex |
|---|---|---|---|---|---|
| coral | shu 朱 | `#EB6101` | marin | konpeki 紺碧 | `#007BBB` |
| blaze | hi 緋 | `#D3381C` | nova | ruri 瑠璃 | `#1E50A2` |
| adrian | akane 茜 | `#B7282E` | ethan | ai 藍 | `#004C71` |
| ballad | suō 蘇芳 | `#9E3D3F` | fable | kikyō 桔梗 | `#5654A2` |
| jasphina | tsutsuji 躑躅 | `#E95295` | verse | edo-murasaki 江戸紫 | `#745399` |
| sarah | sakura 桜 | vivified | alloy | ginnezu 銀鼠 | `#AFAFB0` |
| ash | kohaku 琥珀 | `#BF783A` | onyx | sumi 墨 | `#595857` |
| sage | moegi 萌黄 | `#AACF53` | grim | seiji 青磁 | `#819C8B` |
| cedar | tokiwa 常磐 | `#007B43` | shimmer | tamamushi 玉虫 | iridescent |

Fit notes: onyx→sumi makes the "voice as ink" pun literal; echo→asagi (`#00A3AF`) is a perfect
hue match and the family's brightest teal; shimmer→tamamushi legitimizes its iridescence as the one
deliberately unstable member; sarah's sakura needs a vivified anchor (canonical `#FEF4F4` is ground,
not figure) — the name fixes the hue, OKLCH fixes the chroma. Spare vivid names (kurenai, yamabuki,
wakakusa, kincha) are headroom for future voices; yamabuki stays reserved as the *brand* accent so
no voice owns the app's own color.

**Ban compliance.** nova takes ruri — deeper and inkier than Google-blue `#4285F4`, killing the SaaS
read. fable/verse purples stay flat editorial murasaki set against paper/ink + the yamabuki accent —
never blended with blue in a gradient, which is precisely the banned AI wash.

**Naming register.** Keep vendor ids as system keys; surface the Japanese name as the *color's*
name, not the voice's: "coral — 朱 shu". This gives the subtle Japanese layer a typographic form
(kanji as micro-detail on share pages, romaji in the picker) without renaming voices users already
know, and gives every color a Porsche-grade biography for marketing and merch.

**Token shape.** Extend Theme.swift's existing pattern: per voice, `solid = dynamic(light:dark:)` +
`text = dynamic(light:dark:)`, all four values derived from one OKLCH anchor at build time (a small
script, not a runtime dependency). True-light and true-dark stay an equal pair because both are
graded from the same anchor, neither derived from the other.
