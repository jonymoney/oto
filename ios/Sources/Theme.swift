import SwiftUI

/// oto brand palette — GENERATED from docs/brand/tokens.json (1.0.0).
/// Do not edit by hand: run `node scripts/gen-swift.mjs`.
/// Identity: Chōkan on byakuroku, moegi accent — see docs/brand/BRAND.md.
enum Theme {
    /// byakuroku 白緑 — ground
    static let bg = dynamic(light: 0xf4f7ee, dark: 0x181a13)
    /// gofun 胡粉 — cards, player, bars
    static let surface = dynamic(light: 0xfafcf5, dark: 0x1f221a)
    /// shironeri 白練 — sheets, menus, dialogs
    static let surface2 = dynamic(light: 0xffffff, dark: 0x262a20)
    /// shikkoku 漆黒 — primary text
    static let ink = dynamic(light: 0x181a13, dark: 0xeef1e5)
    /// rikyūnezu 利休鼠 — secondary text, timecodes
    static let ink2 = dynamic(light: 0x6d7561, dark: 0x99a189)
    /// tertiary text, placeholders
    static let ink3 = dynamic(light: 0x8f977f, dark: 0x6f7663)
    /// hairline separators
    static let line = dynamic(light: 0xdde3d1, dark: 0x2c3025)
    /// moegi 萌黄 — on-air dot, NEW, focus, CTAs
    static let accent = dynamic(light: 0x7ba428, dark: 0xaacf53)
    /// moegi at text sizes (eyebrows, links)
    static let accentText = dynamic(light: 0x5c7d1e, dark: 0xaacf53)
    /// kurenai 紅 — errors, destructive
    static let danger = dynamic(light: 0xc22645, dark: 0xff7d92)

    /// Canonical anchor per voice (dentōshoku names). One hue per voice —
    /// pair it with the voice initial or name, never color alone.
    static func voiceAnchor(_ voice: String) -> Color {
        Color(uiColor: uiColor(voiceAnchors[voice.lowercased()] ?? 0x8f977f))
    }

    private static let voiceAnchors: [String: Int] = [
        "coral": 0xeb6101, // 朱 shu
        "echo": 0x00a3af, // 浅葱 asagi
        "nova": 0x1e50a2, // 瑠璃 ruri
        "sage": 0x7ba428, // 萌黄 moegi
        "fable": 0x5654a2, // 桔梗 kikyo
        "verse": 0x745399, // 江戸紫 edo_murasaki
        "ballad": 0x9e3d3f, // 蘇芳 suo
        "ash": 0xbf783a, // 琥珀 kohaku
        "alloy": 0xafafb0, // 銀鼠 ginnezu
        "onyx": 0x595857, // 墨 sumi
        "shimmer": 0x3f8f7a, // 玉虫 tamamushi
        "blaze": 0xd3381c, // 緋 hi
        "adrian": 0xb7282e, // 茜 akane
        "jasphina": 0xe95295, // 躑躅 tsutsuji
        "sarah": 0xf0a0b4, // 桜 sakura
        "cedar": 0x007b43, // 常磐 tokiwa
        "marin": 0x007bbb, // 紺碧 konpeki
        "ethan": 0x004c71, // 藍 ai
        "grim": 0x819c8b, // 青磁 seiji
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
