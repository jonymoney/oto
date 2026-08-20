import SwiftUI

/// Per-voice color palettes for the liquid voice orbs. Designed against the
/// dark app background (Theme.bg); hues spread across the wheel so each voice
/// reads distinctly in the horizontal picker.
enum OrbPalettes {
    static func palette(for voice: String) -> [Color] {
        palettes[voice.lowercased()] ?? defaultPalette
    }

    private static let defaultPalette: [Color] = [
        Color(red: 0.62, green: 0.68, blue: 0.78),
        Color(red: 0.42, green: 0.50, blue: 0.68),
        Color(red: 0.80, green: 0.84, blue: 0.90),
    ]

    private static let palettes: [String: [Color]] = [
        // alloy — dependable brushed steel, cool silver-blues
        "alloy": [
            Color(red: 0.62, green: 0.68, blue: 0.78),
            Color(red: 0.42, green: 0.50, blue: 0.68),
            Color(red: 0.80, green: 0.84, blue: 0.90),
        ],
        // ash — smoky latte warmth with a coffee-ember glow
        "ash": [
            Color(red: 0.55, green: 0.47, blue: 0.42),
            Color(red: 0.76, green: 0.64, blue: 0.54),
            Color(red: 0.95, green: 0.55, blue: 0.30),
        ],
        // ballad — romantic rose and deep burgundy
        "ballad": [
            Color(red: 0.72, green: 0.30, blue: 0.42),
            Color(red: 0.48, green: 0.18, blue: 0.32),
            Color(red: 0.88, green: 0.62, blue: 0.70),
        ],
        // coral — bright sun-warm coral, amber, and hot pink
        "coral": [
            Color(red: 0.98, green: 0.45, blue: 0.35),
            Color(red: 0.98, green: 0.65, blue: 0.30),
            Color(red: 0.95, green: 0.35, blue: 0.55),
        ],
        // echo — calm tidal teal and seafoam
        "echo": [
            Color(red: 0.25, green: 0.60, blue: 0.60),
            Color(red: 0.55, green: 0.82, blue: 0.76),
            Color(red: 0.15, green: 0.38, blue: 0.48),
        ],
        // fable — storybook royal violet with a gilded accent
        "fable": [
            Color(red: 0.48, green: 0.32, blue: 0.75),
            Color(red: 0.68, green: 0.50, blue: 0.90),
            Color(red: 0.92, green: 0.75, blue: 0.35),
        ],
        // nova — crisp electric blue and ice
        "nova": [
            Color(red: 0.25, green: 0.55, blue: 0.95),
            Color(red: 0.45, green: 0.80, blue: 0.98),
            Color(red: 0.75, green: 0.88, blue: 0.98),
        ],
        // onyx — deep charcoal and graphite with a gold glint
        "onyx": [
            Color(red: 0.16, green: 0.16, blue: 0.19),
            Color(red: 0.30, green: 0.30, blue: 0.36),
            Color(red: 0.80, green: 0.68, blue: 0.42),
        ],
        // sage — unhurried herbal greens and pale olive
        "sage": [
            Color(red: 0.55, green: 0.65, blue: 0.45),
            Color(red: 0.35, green: 0.48, blue: 0.35),
            Color(red: 0.78, green: 0.80, blue: 0.60),
        ],
        // shimmer — iridescent pastels, opal pink to mint
        "shimmer": [
            Color(red: 0.95, green: 0.75, blue: 0.85),
            Color(red: 0.80, green: 0.72, blue: 0.95),
            Color(red: 0.70, green: 0.92, blue: 0.85),
            Color(red: 0.75, green: 0.85, blue: 0.98),
        ],
        // verse — poetic indigo ink and orchid magenta
        "verse": [
            Color(red: 0.30, green: 0.25, blue: 0.62),
            Color(red: 0.80, green: 0.35, blue: 0.75),
            Color(red: 0.65, green: 0.55, blue: 0.92),
        ],
        // marin — trustworthy open-ocean navy, azure, and foam
        "marin": [
            Color(red: 0.12, green: 0.35, blue: 0.60),
            Color(red: 0.20, green: 0.60, blue: 0.85),
            Color(red: 0.60, green: 0.88, blue: 0.90),
        ],
        // cedar — grounded cedar wood, forest green, warm amber
        "cedar": [
            Color(red: 0.55, green: 0.36, blue: 0.24),
            Color(red: 0.28, green: 0.42, blue: 0.30),
            Color(red: 0.85, green: 0.60, blue: 0.35),
        ],
        // sarah — soft blush, cream, and quiet lavender (Fish)
        "sarah": [
            Color(red: 0.95, green: 0.80, blue: 0.78),
            Color(red: 0.98, green: 0.92, blue: 0.84),
            Color(red: 0.78, green: 0.70, blue: 0.88),
        ],
        // ethan — petrol blue and slate, documentary calm (Fish)
        "ethan": [
            Color(red: 0.18, green: 0.32, blue: 0.42),
            Color(red: 0.35, green: 0.52, blue: 0.58),
            Color(red: 0.62, green: 0.74, blue: 0.76),
        ],
        // adrian — storm gray with a deep crimson undercurrent (Fish)
        "adrian": [
            Color(red: 0.28, green: 0.26, blue: 0.32),
            Color(red: 0.55, green: 0.14, blue: 0.20),
            Color(red: 0.72, green: 0.60, blue: 0.62),
        ],
        // jasphina — electric magenta, tangerine, and violet mischief (Fish)
        "jasphina": [
            Color(red: 0.95, green: 0.25, blue: 0.65),
            Color(red: 0.98, green: 0.55, blue: 0.25),
            Color(red: 0.60, green: 0.30, blue: 0.90),
        ],
        // blaze — roaring fire orange, red, and gold (Fish)
        "blaze": [
            Color(red: 0.98, green: 0.42, blue: 0.12),
            Color(red: 0.85, green: 0.15, blue: 0.12),
            Color(red: 0.98, green: 0.78, blue: 0.25),
        ],
        // grim — near-black with a pale ghost-green glow (Fish)
        "grim": [
            Color(red: 0.10, green: 0.13, blue: 0.11),
            Color(red: 0.25, green: 0.38, blue: 0.30),
            Color(red: 0.62, green: 0.85, blue: 0.66),
        ],
    ]
}
