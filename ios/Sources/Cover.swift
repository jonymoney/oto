import SwiftUI
import UIKit

/// Deterministic generative cover art. The web app implements the identical
/// spec (FNV-1a seed → mulberry32 PRNG → per-style renderer; see
/// specs/cover-lab.html), so the same audio id renders the same cover on both
/// platforms. Do not change any PRNG pull order — it must stay bit-for-bit
/// with the JS. All animation is frozen at t = 0.
///
/// Styles: "classic" (mesh), "ink" (4 sub-families), "halftone".
/// Unknown/absent style → classic. An audio always renders in its CREATOR's
/// style (`item.coverStyle`), never the viewer's.
///
/// Size tiers: below 160pt only the ground is drawn (call sites keep their
/// existing emoji-chip treatment); at ≥160pt with a title, the editorial type
/// layer (strap + title + emoji over a scrim/veil) is composed on top.
struct CoverView: View {
    let id: String
    var mood: String?
    var size: CGFloat
    var style: String = "classic"
    var title: String? = nil
    var meta: String? = nil
    var emoji: String? = nil

    private var resolvedStyle: String {
        style == "ink" || style == "halftone" ? style : "classic"
    }
    /// Classic mesh is a dark ground (scrim + light type); ink and halftone
    /// print on light paper stock (veil + dark ink type).
    private var darkGround: Bool { resolvedStyle == "classic" }
    private var showsType: Bool { size >= 160 && !(title ?? "").isEmpty }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Canvas { ctx, canvasSize in
                let s = canvasSize.width
                switch resolvedStyle {
                case "ink":
                    CoverArt.drawInk(&ctx, s: s, id: id)
                case "halftone":
                    CoverArt.drawHalftone(&ctx, s: s, id: id, emoji: emoji)
                default:
                    CoverArt.drawClassic(&ctx, s: s, id: id, mood: mood)
                }
                if showsType {
                    CoverArt.drawScrim(&ctx, s: s, dark: darkGround)
                }
            }
            if showsType { typeLayer }
        }
        .frame(width: size, height: size)
        .clipped()
    }

    // MARK: Editorial type layer (lab: editorialType() — geometry-approximate,
    // only the ground must match the web pixel-for-pixel; fonts differ).

    private var typeLayer: some View {
        let ink: Color = darkGround ? .white : CoverArt.color(0x181A13)
        return VStack(alignment: .leading, spacing: size * 0.1) {
            Text(strapText)
                .font(.system(size: size * 0.042, weight: .medium, design: .monospaced))
                .opacity(darkGround ? 0.78 : 0.62)
                .lineLimit(1)
            titleText
                .lineLimit(4)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .foregroundStyle(ink)
        .padding(size * 0.09)
        .frame(width: size, height: size, alignment: .topLeading)
        .allowsHitTesting(false)
    }

    private var strapText: String {
        (["oto", mood, meta].compactMap { $0 }.filter { !$0.isEmpty })
            .joined(separator: " · ").uppercased()
    }

    /// Big lowercase title, every third word in serif italic, emoji appended.
    private var titleText: Text {
        let fs = size * 0.1
        let words = (title ?? "").lowercased()
            .replacingOccurrences(of: ":", with: "")
            .split(separator: " ").map(String.init)
        var t = Text(verbatim: "")
        for (i, w) in words.enumerated() {
            let piece = i % 3 == 1
                ? Text(w).font(.system(size: fs, weight: .semibold, design: .serif).italic())
                : Text(w).font(.system(size: fs, weight: .semibold))
            t = i == 0 ? piece : t + Text(verbatim: " ").font(.system(size: fs)) + piece
        }
        if let e = emoji, !e.isEmpty {
            t = t + Text(verbatim: " ").font(.system(size: fs)) + Text(e).font(.system(size: fs))
        }
        return t
    }
}

/// "7 min · en" strap metadata, matching the web covers' format.
func coverMeta(durationSec: Double?, language: String?) -> String? {
    var parts: [String] = []
    if let d = durationSec, d > 0 { parts.append("\(max(1, Int((d / 60).rounded()))) min") }
    if let l = language, !l.isEmpty { parts.append(l) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
    static let tau = Double.pi * 2

    static func fnv1a(_ s: String) -> UInt32 {
        var h: UInt32 = 2166136261
        for byte in s.utf8 { h = (h ^ UInt32(byte)) &* 16777619 }
        return h
    }

    /// JS `pick(R, arr)` — one pull, floor to index.
    static func pick<T>(_ rng: inout Mulberry32, _ arr: [T]) -> T {
        arr[Int(rng.next() * Double(arr.count))]
    }

    static func color(_ hex: Int) -> Color {
        Color(
            red:   Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue:  Double(hex & 0xff) / 255
        )
    }

    private static func square(_ s: Double) -> Path {
        Path(CGRect(x: 0, y: 0, width: s, height: s))
    }

    private static func circle(_ cx: Double, _ cy: Double, _ r: Double) -> Path {
        Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    }

    // MARK: - Classic mesh (unchanged — bit-for-bit with the original)

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

    static func drawClassic(_ ctx: inout GraphicsContext, s: Double, id: String, mood: String?) {
        let w = s
        let pal = palette(id: id, mood: mood)
        let sq = square(s)
        ctx.fill(sq, with: .color(pal[2]))

        var rng = Mulberry32(seed: fnv1a(id))
        for i in 0..<7 {
            let x = rng.next() * w
            let y = rng.next() * w
            let r = w * (0.35 + rng.next() * 0.5)
            let c = pal[i % 3]
            ctx.fill(
                sq,
                with: .radialGradient(
                    Gradient(colors: [c, c.opacity(0)]),
                    center: CGPoint(x: x, y: y),
                    startRadius: 0,
                    endRadius: r
                )
            )
        }
    }

    // MARK: - Ink (lab: inkRings/inkContours/inkBurst/inkHex, t = 0)

    /// Curated paper/ink stocks — copied verbatim from the lab's INK_STOCK.
    private static let inkStock: [(paper: Int, ink: Int)] = [
        (0xF1EBDC, 0x15130F), // shikkoku on cream
        (0xF4F7EE, 0x181A13), // shikkoku on byakuroku
        (0xFAFCF5, 0x1E50A2), // ruri on gofun
        (0xF2EDDF, 0x9E3D3F), // suo on cream
        (0xF4F7EE, 0x5C7D1E), // moegi on byakuroku
        (0xF1EBDC, 0x004C71), // ai on cream
        (0xFFFFFF, 0x595857), // sumi on shironeri
        (0xF2EDDF, 0xD3381C), // hi on cream
    ]

    static func drawInk(_ ctx: inout GraphicsContext, s: Double, id: String) {
        var rng = Mulberry32(seed: fnv1a(id))
        // FIRST pull selects the sub-family, then that family draws with the same rng.
        let family = Int(rng.next() * 4)
        switch family {
        case 0: inkRings(&ctx, s, &rng)
        case 1: inkContours(&ctx, s, &rng)
        case 2: inkBurst(&ctx, s, &rng)
        default: inkHex(&ctx, s, &rng)
        }
    }

    /// Paper fill + 6.5% poster-margin clip. Returns (paper, ink, clipped ctx).
    private static func inkStart(
        _ base: inout GraphicsContext, _ s: Double, _ rng: inout Mulberry32
    ) -> (paper: Color, ink: Color, x: GraphicsContext) {
        let st = pick(&rng, inkStock)
        base.fill(square(s), with: .color(color(st.paper)))
        var x = base
        let m = s * 0.065
        x.clip(to: Path(CGRect(x: m, y: m, width: s - 2 * m, height: s - 2 * m)))
        return (color(st.paper), color(st.ink), x)
    }

    private static func inkRings(_ base: inout GraphicsContext, _ s: Double, _ rng: inout Mulberry32) {
        let (_, ink, x0) = inkStart(&base, s, &rng)
        let crop = rng.next() < 0.38
        let cx = s * (crop ? (rng.next() < 0.5 ? 0.16 : 0.84) : 0.5 + (rng.next() - 0.5) * 0.18)
        let cy = s * (crop ? 0.5 + (rng.next() - 0.5) * 0.5 : 0.5 + (rng.next() - 0.5) * 0.18)
        let rad = s * (crop ? 0.72 + rng.next() * 0.22 : 0.40 + rng.next() * 0.05)
        let rings = 9 + Int(rng.next() * 9)
        let gap = rad / Double(rings)
        let lw = gap * (0.34 + rng.next() * 0.16)
        let dir = rng.next() * tau
        _ = rng.next() // spin — only multiplies t, but the pull must happen
        let drift = gap * (0.9 + rng.next() * 0.7)
        var x = x0
        x.clip(to: circle(cx, cy, rad))
        for i in 1...rings {
            let k = Double(i) / Double(rings)
            let ocx = cx + cos(dir) * drift * k
            let ocy = cy + sin(dir) * drift * k
            x.stroke(circle(ocx, ocy, gap * Double(i) - lw * 0.5), with: .color(ink), lineWidth: lw)
        }
        x.fill(circle(cx, cy, gap * 0.55), with: .color(ink)) // focal: the solid eye
    }

    private static func inkContours(_ base: inout GraphicsContext, _ s: Double, _ rng: inout Mulberry32) {
        let (_, ink, x) = inkStart(&base, s, &rng)
        let cx = s * (0.42 + rng.next() * 0.16)
        let cy = s * (0.42 + rng.next() * 0.16)
        let rBase = s * (0.10 + rng.next() * 0.06)
        // Harmonics: pull order per entry is n, a, p, w (w only multiplies t).
        var n = [Double](), a = [Double](), p = [Double]()
        for (nLo, nSpan, aLo, aSpan) in [(2.0, 2.0, 0.30, 0.16), (4.0, 2.0, 0.16, 0.10), (7.0, 3.0, 0.07, 0.05)] {
            n.append(nLo + Double(Int(rng.next() * nSpan)))
            a.append(aLo + rng.next() * aSpan)
            p.append(rng.next() * tau)
            _ = rng.next() // w
        }
        let sp = s * (0.030 + rng.next() * 0.016) * (1 + 0.07 * sin(p[0]))
        _ = rng.next() // slide — direction of the t-drift only
        let bands = Int(ceil(s * 0.95 / sp)) + 3
        let seg = 96
        func rAt(_ k: Double, _ th: Double) -> Double {
            let fall = 1 / (1 + abs(k) * 0.13)
            var r = rBase + k * sp
            for q in 0..<3 { r += rBase * a[q] * fall * sin(n[q] * th + p[q]) }
            return r
        }
        var k = -2
        while k < bands {
            var path = Path()
            for lvl in 0..<2 {
                let kk = Double(k + lvl)
                for i in 0...seg {
                    let th = Double(i) / Double(seg) * tau
                    let r = max(0, rAt(kk, th))
                    let pt = CGPoint(x: cx + cos(th) * r, y: cy + sin(th) * r)
                    if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                }
                path.closeSubpath()
            }
            x.fill(path, with: .color(ink), style: FillStyle(eoFill: true))
            k += 2
        }
    }

    private static func inkBurst(_ base: inout GraphicsContext, _ s: Double, _ rng: inout Mulberry32) {
        let (paper, ink, x) = inkStart(&base, s, &rng)
        let edge = rng.next() < 0.45
        let ox = s * (edge ? (rng.next() < 0.5 ? 0.08 : 0.92) : 0.5 + (rng.next() - 0.5) * 0.14)
        let oy = s * (edge ? 0.5 + (rng.next() - 0.5) * 0.6 : 0.5 + (rng.next() - 0.5) * 0.14)
        let spokes = 14 + Int(rng.next() * 16) * 2
        _ = rng.next() // spin — t only
        let ph = rng.next() * tau
        let thin = 0.16 + rng.next() * 0.16
        for i in 0..<spokes {
            let a0 = ph + Double(i) / Double(spokes) * tau
            // JS pulls R only for even spokes — preserve that order exactly.
            let w = tau / Double(spokes) * (i % 2 == 1 ? thin : 0.40 + rng.next() * 0.12)
            var path = Path()
            path.move(to: CGPoint(x: ox, y: oy))
            // The arc at r = 1.6s lies entirely off-canvas; a polyline arc
            // avoids any Path.addArc winding ambiguity.
            for j in 0...8 {
                let an = a0 + w * Double(j) / 8
                path.addLine(to: CGPoint(x: ox + cos(an) * s * 1.6, y: oy + sin(an) * s * 1.6))
            }
            path.closeSubpath()
            x.fill(path, with: .color(ink))
        }
        let rr = s * (0.10 + rng.next() * 0.07) // focal: hub + hairline
        x.fill(circle(ox, oy, rr), with: .color(paper))
        x.stroke(circle(ox, oy, rr * (1.45 + 0.05 * sin(ph))), with: .color(ink), lineWidth: s * 0.012)
    }

    private static func inkHex(_ base: inout GraphicsContext, _ s: Double, _ rng: inout Mulberry32) {
        let (_, ink, x) = inkStart(&base, s, &rng)
        let r = s * (0.055 + rng.next() * 0.035)
        let lw = r * 0.13 // t = 0: the .02·sin breath term is 0
        let dx = r * 1.732, dy = r * 1.5
        let cols = Int(ceil(s / dx)) + 2, rows = Int(ceil(s / dy)) + 2
        let fx = s * (0.25 + rng.next() * 0.5)
        let fy = s * (0.25 + rng.next() * 0.5)
        let fr = r * (1.2 + rng.next() * 0.9)
        // drift = sin(0)·.5 = 0
        let strokeStyle = StrokeStyle(lineWidth: lw, lineJoin: .round)
        for j in -1..<rows {
            for i in -1..<cols {
                let hx = Double(i) * dx + (j & 1 == 1 ? dx / 2 : 0)
                let hy = Double(j) * dy
                var path = Path()
                for k in 0..<6 {
                    let an = Double(k) * tau / 6 + .pi / 6
                    let pt = CGPoint(x: hx + cos(an) * r * 0.94, y: hy + sin(an) * r * 0.94)
                    if k == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                }
                path.closeSubpath()
                if ((hx - fx) * (hx - fx) + (hy - fy) * (hy - fy)).squareRoot() < fr {
                    x.fill(path, with: .color(ink)) // focal cluster
                }
                x.stroke(path, with: .color(ink), style: strokeStyle)
            }
        }
    }

    // MARK: - Halftone (lab: halftone()/htSource()/htSample(), t = 0)

    private static let htw = 168
    /// Curated ink sets + paper — copied verbatim from the lab's HT_INKS.
    private static let htInks: [(inks: [Int], paper: Int)] = [
        (inks: [0x00A3AF, 0xEB6101, 0x181A13], paper: 0xFAFCF5), // asagi/shu
        (inks: [0x1E50A2, 0xC22645, 0x12141C], paper: 0xF2EDDF), // ruri/kurenai
        (inks: [0x7BA428, 0x595857, 0x181A13], paper: 0xF4F7EE), // moegi/sumi
        (inks: [0x5654A2, 0xE95295, 0x1A1620], paper: 0xFFFFFF), // kikyo/tsutsuji
        (inks: [0x007B43, 0xBF783A, 0x14140F], paper: 0xF1EBDC), // tokiwa/kohaku
        (inks: [0x007BBB, 0xF8B500, 0x101418], paper: 0xFAFCF5), // konpeki/yamabuki
        (inks: [0x595857, 0xEB6101, 0x181A13], paper: 0xF4F7EE), // sumi/shu
        (inks: [0x819C8B, 0xB7282E, 0x171310], paper: 0xF0EADB), // seiji/akane
    ]

    static func drawHalftone(_ ctx: inout GraphicsContext, s: Double, id: String, emoji: String?) {
        var rng = Mulberry32(seed: fnv1a(id))
        let fixed: String? = (emoji?.isEmpty == false) ? emoji : nil
        // Production contract (matches src/share.ts + ui/src/covers.ts): emoji
        // present → its silhouette, absent → blob. Neither consumes the cover
        // rng — the lab's fixedEmoji path. (The lab's no-emoji branch pulled
        // twice and could pick a random decorative emoji; production doesn't.)
        let useEmoji = fixed != nil
        let em = fixed ?? ""
        // Five collision-avoidance channels — exact pull order.
        let set = pick(&rng, htInks)
        let pitch = s / Double(14 + Int(rng.next() * 18))
        let zoom = 0.72 + rng.next() * 1.25
        let spin = (rng.next() - 0.5) * 0.9
        let shx = (rng.next() - 0.5) * 0.30
        let shy = (rng.next() - 0.5) * 0.30
        let aoff = rng.next() * .pi / 2
        let mis = 0.06 + rng.next() * 0.5
        let ang = [15.0, 75.0, 45.0].map { $0 * .pi / 180 + aoff }
        var reg: [(Double, Double)] = []
        for _ in 0..<3 {
            let rx = (rng.next() - 0.5) * pitch * mis
            let ry = (rng.next() - 0.5) * pitch * mis
            reg.append((rx, ry))
        }
        let gain = 0.95 + rng.next() * 0.3
        let brz = rng.next() * tau
        let dph = rng.next() * tau

        // JS booleans stringify as "true"/"false" in the buffer key.
        let key = "\(id)|\(useEmoji)\(em)"
        let dens = densityBuffers(key: key, useEmoji: useEmoji, emoji: em)

        ctx.fill(square(s), with: .color(color(set.paper)))
        // t = 0 evaluations of the breathing/turn terms.
        let zm = zoom * (1 + 0.045 * sin(brz))
        let rt = spin + 0.05 * sin(dph)
        let cr = cos(rt) / zm, sr = sin(rt) / zm
        let px0 = shx + 0.012 * sin(dph)
        let py0 = shy + 0.012 * cos(brz)
        let reach = Int(ceil(s * 0.78 / pitch))
        for k in 0..<3 {
            let ca = cos(ang[k]), sa = sin(ang[k])
            var path = Path()
            for j in -reach...reach {
                for i in -reach...reach {
                    let gx = Double(i) * pitch + reg[k].0
                    let gy = Double(j) * pitch + reg[k].1
                    let dxp = s * 0.5 + gx * ca - gy * sa
                    let dyp = s * 0.5 + gx * sa + gy * ca
                    if dxp < -pitch || dyp < -pitch || dxp > s + pitch || dyp > s + pitch { continue }
                    let u = dxp / s - 0.5 + px0
                    let v = dyp / s - 0.5 + py0
                    let d = htSample(dens[k],
                                     (u * cr - v * sr + 0.5) * Double(htw),
                                     (u * sr + v * cr + 0.5) * Double(htw))
                    if d < 0.035 { continue }
                    let rr = pitch * 0.63 * min(1, d * gain).squareRoot() // area ∝ density
                    path.addEllipse(in: CGRect(x: dxp - rr, y: dyp - rr, width: rr * 2, height: rr * 2))
                }
            }
            var layer = ctx
            layer.blendMode = .multiply
            layer.opacity = k == 2 ? 0.92 : 0.85
            layer.fill(path, with: .color(color(set.inks[k])))
        }
    }

    /// Bilinear sample of a 168² density plate (JS htSample).
    private static func htSample(_ buf: [Float], _ bx: Double, _ by: Double) -> Double {
        let w = htw
        if bx < 0 || by < 0 || bx > Double(w) - 1.01 || by > Double(w) - 1.01 { return 0 }
        let ix = Int(bx), iy = Int(by)
        let fx = bx - Double(ix), fy = by - Double(iy)
        let o = iy * w + ix
        return Double(buf[o]) * (1 - fx) * (1 - fy) + Double(buf[o + 1]) * fx * (1 - fy)
            + Double(buf[o + w]) * (1 - fx) * fy + Double(buf[o + w + 1]) * fx * fy
    }

    // MARK: Halftone density plates (JS htSource) — computed once per key.

    // nonisolated(unsafe): every access is guarded by densLock below.
    nonisolated(unsafe) private static var densCache: [String: [[Float]]] = [:]
    private static let densLock = NSLock()

    private static func densityBuffers(key: String, useEmoji: Bool, emoji: String) -> [[Float]] {
        densLock.lock()
        defer { densLock.unlock() }
        if let hit = densCache[key] { return hit }
        var rng = Mulberry32(seed: fnv1a(key))
        let dens = useEmoji ? emojiDensity(emoji) : blobDensity(&rng)
        // ponytail: crude cap — each entry is ~340KB; wipe past 16, LRU if it ever matters
        if densCache.count > 16 { densCache.removeAll() }
        densCache[key] = dens
        return dens
    }

    /// Subtractive CMY separation with grey-component removal of the blurred
    /// emoji glyph — the "real plates" path.
    private static func emojiDensity(_ emoji: String) -> [[Float]] {
        let w = htw, count = w * w
        var zero = [[Float]](repeating: [Float](repeating: 0, count: count), count: 3)
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = false
        let img = UIGraphicsImageRenderer(size: CGSize(width: w, height: w), format: fmt).image { _ in
            let str = NSAttributedString(
                string: emoji,
                attributes: [.font: UIFont.systemFont(ofSize: CGFloat(w) * 0.84)]
            )
            let sz = str.size()
            str.draw(at: CGPoint(x: CGFloat(w) * 0.5 - sz.width / 2, y: CGFloat(w) * 0.53 - sz.height / 2))
        }
        guard let cg = img.cgImage else { return zero }
        var pm = [UInt8](repeating: 0, count: count * 4)
        let ok = pm.withUnsafeMutableBytes { buf -> Bool in
            guard let c = CGContext(
                data: buf.baseAddress, width: w, height: w, bitsPerComponent: 8,
                bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: w))
            return true
        }
        guard ok else { return zero }
        // Premultiplied float channels → blur (canvas dot-gain blur happens on
        // the composited image) → un-premultiply → separation.
        var rP = [Float](repeating: 0, count: count)
        var gP = rP, bP = rP, aP = rP
        for i in 0..<count {
            rP[i] = Float(pm[i * 4]) / 255
            gP[i] = Float(pm[i * 4 + 1]) / 255
            bP[i] = Float(pm[i * 4 + 2]) / 255
            aP[i] = Float(pm[i * 4 + 3]) / 255
        }
        let sigma = Double(w) * 0.012 / 2 // CSS blur(r): σ = r/2
        rP = gaussBlur(rP, w: w, sigma: sigma)
        gP = gaussBlur(gP, w: w, sigma: sigma)
        bP = gaussBlur(bP, w: w, sigma: sigma)
        aP = gaussBlur(aP, w: w, sigma: sigma)
        for i in 0..<count {
            let al = aP[i]
            if al < 0.01 { continue }
            let r = min(1, rP[i] / al), g = min(1, gP[i] / al), b = min(1, bP[i] / al)
            let cy = 1 - r, mg = 1 - g, yl = 1 - b
            let k = min(cy, min(mg, yl))
            zero[0][i] = al * min(1, (cy - k) * 1.45 + (yl - k) * 0.22)
            zero[1][i] = al * min(1, (mg - k) * 1.35 + (yl - k) * 0.72)
            zero[2][i] = al * min(0.8, k * 0.78) // key plate stays a shadow
        }
        return zero
    }

    /// One harmonic blob printed as a mis-registered duotone. Canvas composites
    /// three pure-channel plates with 'lighter'; the straight-alpha read-back
    /// cancels alpha, so each plate reduces to its own blurred coverage mask
    /// times a gradient weight.
    private static func blobDensity(_ rng: inout Mulberry32) -> [[Float]] {
        let w = htw, count = w * w
        let cx = Double(w) * (0.44 + rng.next() * 0.12)
        let cy = Double(w) * (0.44 + rng.next() * 0.12)
        let rad = Double(w) * (0.30 + rng.next() * 0.07)
        let h0 = rng.next() * tau, h1 = rng.next() * tau, h2 = rng.next() * tau
        let sigma = Double(w) * 0.03 / 2
        // (dx, dy, scale) per plate — R, G, B in the JS.
        let plates: [(Double, Double, Double)] = [
            (-rad * 0.045, -rad * 0.03, 1.0),
            (rad * 0.05, rad * 0.035, 0.96),
            (rad * 0.14, rad * 0.13, 0.62),
        ]
        var dens = [[Float]](repeating: [Float](repeating: 0, count: count), count: 3)
        for (p, (dx, dy, k)) in plates.enumerated() {
            var cov = rasterBlob(w: w, cx: cx + dx, cy: cy + dy, rad: rad * k, h: (h0, h1, h2))
            cov = gaussBlur(cov, w: w, sigma: sigma)
            for i in 0..<count {
                let gx = Double(i % w) / Double(w)
                let gy = Double(i / w) / Double(w)
                let weight: Double
                switch p {
                case 0: weight = 0.30 + 0.80 * (1 - gx)
                case 1: weight = 0.30 + 0.80 * gx
                default: weight = 0.18 + 0.55 * gy
                }
                dens[p][i] = cov[i] * Float(weight)
            }
        }
        return dens
    }

    /// Rasterize the 120-segment harmonic blob into an alpha coverage buffer.
    private static func rasterBlob(w: Int, cx: Double, cy: Double, rad: Double, h: (Double, Double, Double)) -> [Float] {
        var bytes = [UInt8](repeating: 0, count: w * w)
        bytes.withUnsafeMutableBytes { buf in
            // 8-bit grayscale, white shape on the zeroed (black) buffer.
            guard let c = CGContext(
                data: buf.baseAddress, width: w, height: w, bitsPerComponent: 8,
                bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return }
            // Flip so memory row 0 = top, matching canvas/ImageData orientation.
            c.translateBy(x: 0, y: CGFloat(w))
            c.scaleBy(x: 1, y: -1)
            let path = CGMutablePath()
            for i in 0...120 {
                let th = Double(i) / 120 * tau
                let rr = rad * (1 + 0.24 * sin(3 * th + h.0) + 0.13 * sin(5 * th + h.1) + 0.08 * sin(7 * th + h.2))
                let pt = CGPoint(x: cx + cos(th) * rr, y: cy + sin(th) * rr)
                if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
            }
            path.closeSubpath()
            c.addPath(path)
            c.setFillColor(CGColor(gray: 1, alpha: 1))
            c.fillPath()
        }
        return bytes.map { Float($0) / 255 }
    }

    /// Separable Gaussian, zero-padded at the edges (canvas blur treats
    /// outside as transparent).
    private static func gaussBlur(_ src: [Float], w: Int, sigma: Double) -> [Float] {
        let hgt = src.count / w
        let r = max(1, Int((sigma * 3).rounded(.up)))
        var kernel = [Float](repeating: 0, count: 2 * r + 1)
        var sum: Float = 0
        for i in -r...r {
            let v = Float(exp(-Double(i * i) / (2 * sigma * sigma)))
            kernel[i + r] = v
            sum += v
        }
        for i in kernel.indices { kernel[i] /= sum }
        var tmp = [Float](repeating: 0, count: src.count)
        var out = tmp
        for y in 0..<hgt {
            for x in 0..<w {
                var acc: Float = 0
                for d in -r...r {
                    let xx = x + d
                    if xx >= 0 && xx < w { acc += src[y * w + xx] * kernel[d + r] }
                }
                tmp[y * w + x] = acc
            }
        }
        for y in 0..<hgt {
            for x in 0..<w {
                var acc: Float = 0
                for d in -r...r {
                    let yy = y + d
                    if yy >= 0 && yy < hgt { acc += tmp[yy * w + x] * kernel[d + r] }
                }
                out[y * w + x] = acc
            }
        }
        return out
    }

    // MARK: - Scrim / veil under the editorial type (lab: coverScrim)

    static func drawScrim(_ ctx: inout GraphicsContext, s: Double, dark: Bool) {
        let stops: [Gradient.Stop]
        if dark { // legibility scrim
            let c = Color(red: 8 / 255, green: 7 / 255, blue: 5 / 255)
            stops = [
                .init(color: c.opacity(0.62), location: 0),
                .init(color: c.opacity(0.30), location: 0.55),
                .init(color: c.opacity(0.66), location: 1),
            ]
        } else { // paper veil for ink/halftone
            let c = Color(red: 244 / 255, green: 247 / 255, blue: 238 / 255)
            stops = [
                .init(color: c.opacity(0.86), location: 0),
                .init(color: c.opacity(0.60), location: 0.60),
                .init(color: c.opacity(0.06), location: 1),
            ]
        }
        ctx.fill(
            square(s),
            with: .linearGradient(
                Gradient(stops: stops),
                startPoint: .zero,
                endPoint: CGPoint(x: 0, y: s)
            )
        )
    }
}

// MARK: - Style picker (shared by onboarding and Settings)

/// Three live preview tiles — tap to select. The previews use one fixed sample
/// id so each style shows its real seeded output.
struct CoverStylePicker: View {
    @Binding var selection: String
    var tileSize: CGFloat = 96

    static let styles: [(id: String, label: String)] = [
        ("classic", "Classic"), ("ink", "Ink"), ("halftone", "Halftone"),
    ]

    var body: some View {
        HStack(spacing: 14) {
            ForEach(Self.styles, id: \.id) { style in
                let selected = selection == style.id
                Button {
                    Haptics.selection()
                    selection = style.id
                } label: {
                    VStack(spacing: 8) {
                        CoverView(id: "oto-style-sample", size: tileSize, style: style.id, emoji: "🦊")
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .strokeBorder(selected ? Theme.accent : Theme.line, lineWidth: selected ? 2.5 : 1)
                            )
                        Text(style.label)
                            .font(.footnote.weight(selected ? .semibold : .regular))
                            .foregroundStyle(selected ? Theme.accent : Theme.ink)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(style.label) cover style")
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
    }
}
