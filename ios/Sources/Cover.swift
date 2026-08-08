import SwiftUI

/// Deterministic generative cover art. The web app implements the identical
/// spec (FNV-1a seed → mulberry32 PRNG → 7 radial "mesh" blobs), so the same
/// audio id renders the same cover on both platforms. Do not change the PRNG
/// pull order (x, y, r per blob) — it must stay bit-for-bit with the JS.
struct CoverView: View {
    let id: String
    var mood: String?
    var size: CGFloat

    var body: some View {
        Canvas { ctx, canvasSize in
            let w = canvasSize.width
            let pal = CoverArt.palette(id: id, mood: mood)
            let square = Path(CGRect(x: 0, y: 0, width: w, height: canvasSize.height))
            ctx.fill(square, with: .color(pal[2]))

            var rng = Mulberry32(seed: CoverArt.fnv1a(id))
            for i in 0..<7 {
                let x = rng.next() * w
                let y = rng.next() * w
                let r = w * (0.35 + rng.next() * 0.5)
                let color = pal[i % 3]
                ctx.fill(
                    square,
                    with: .radialGradient(
                        Gradient(colors: [color, color.opacity(0)]),
                        center: CGPoint(x: x, y: y),
                        startRadius: 0,
                        endRadius: r
                    )
                )
            }
        }
        .frame(width: size, height: size)
    }
}

/// 32-bit mulberry32 PRNG mirroring the JS implementation exactly.
struct Mulberry32 {
    private var a: UInt32
    init(seed: UInt32) { a = seed }

    mutating func next() -> Double {
        a = a &+ 0x6D2B79F5
        var t = a
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    }
}

enum CoverArt {
    static func fnv1a(_ s: String) -> UInt32 {
        var h: UInt32 = 2166136261
        for byte in s.utf8 { h = (h ^ UInt32(byte)) &* 16777619 }
        return h
    }

    // mood → three hex colors. Order of the fallback list is load-bearing.
    private static let palettes: [String: [Int]] = [
        "calm":      [0x1d9e75, 0x0f6e56, 0x378add],
        "energetic": [0xf5a623, 0xd85a30, 0xef9f27],
        "serious":   [0x534ab7, 0x185fa5, 0x3c3489],
        "playful":   [0xd4537e, 0x7f77dd, 0xed93b1],
        "warm":      [0xd85a30, 0xf5a623, 0x993c1d],
    ]
    private static let fallbackOrder = ["warm", "calm", "energetic", "serious", "playful"]

    static func palette(id: String, mood: String?) -> [Color] {
        if let m = mood, !m.isEmpty, let hit = palettes[m] {
            return hit.map(color(_:))
        }
        let key = fallbackOrder[Int(fnv1a(id) % 5)]
        return palettes[key]!.map(color(_:))
    }

    private static func color(_ hex: Int) -> Color {
        Color(
            red:   Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue:  Double(hex & 0xff) / 255
        )
    }
}
