#!/usr/bin/env node
// Generates ios/Sources/Theme.swift from docs/brand/tokens.json.
// Run: node scripts/gen-swift.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(join(root, 'docs/brand/tokens.json'), 'utf8'));

const hex = (s) => `0x${s.replace('#', '').toLowerCase()}`;
const c = t.color;
const pair = (tok) => `dynamic(light: ${hex(tok.light)}, dark: ${hex(tok.dark)})`;

// Theme token → tokens.json mapping (names kept stable for existing call sites).
const themeTokens = [
  ['bg',         c.ground,      'byakuroku 白緑 — ground'],
  ['surface',    c.surface_1,   'gofun 胡粉 — cards, player, bars'],
  ['surface2',   c.surface_2,   'shironeri 白練 — sheets, menus, dialogs'],
  ['ink',        c.ink,         'shikkoku 漆黒 — primary text'],
  ['ink2',       c.ink_muted,   'rikyūnezu 利休鼠 — secondary text, timecodes'],
  ['ink3',       c.ink_faint,   'tertiary text, placeholders'],
  ['line',       c.hairline,    'hairline separators'],
  ['accent',     c.accent,      'moegi 萌黄 — on-air dot, NEW, focus, CTAs'],
  ['accentText', c.accent_text, 'moegi at text sizes (eyebrows, links)'],
  ['danger',     c.error,       'kurenai 紅 — errors, destructive'],
];

const voices = Object.entries(t.voice)
  .map(([k, v]) => `        "${k}": ${hex(v.anchor)}, // ${v.kanji} ${v.name}`)
  .join('\n');

const out = `import SwiftUI

/// oto brand palette — GENERATED from docs/brand/tokens.json (${t.meta.version}).
/// Do not edit by hand: run \`node scripts/gen-swift.mjs\`.
/// Identity: Chōkan on byakuroku, moegi accent — see docs/brand/BRAND.md.
enum Theme {
${themeTokens.map(([n, tok, note]) => `    /// ${note}\n    static let ${n} = ${pair(tok)}`).join('\n')}

    /// Canonical anchor per voice (dentōshoku names). One hue per voice —
    /// pair it with the voice initial or name, never color alone.
    static func voiceAnchor(_ voice: String) -> Color {
        Color(uiColor: uiColor(voiceAnchors[voice.lowercased()] ?? 0x8f977f))
    }

    private static let voiceAnchors: [String: Int] = [
${voices}
    ]

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(uiColor: UIColor { trait in
            uiColor(trait.userInterfaceStyle == .dark ? dark : light)
        })
    }

    private static func uiColor(_ hex: Int) -> UIColor {
        UIColor(
            red:   CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue:  CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }
}
`;

writeFileSync(join(root, 'ios/Sources/Theme.swift'), out);
console.log('wrote ios/Sources/Theme.swift');
