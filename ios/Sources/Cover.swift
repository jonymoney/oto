import SwiftUI
import UIKit

/// Deterministic generative cover art. The web app implements the identical
/// spec (FNV-1a seed → mulberry32 PRNG → per-style renderer; see
/// specs/cover-lab.html), so the same audio id renders the same cover on both
/// platforms. Do not change any PRNG pull order — it must stay bit-for-bit
/// with the JS. All animation is frozen at t = 0.
///
/// Styles: "classic" (mesh), "ink" (4 sub-families), "halftone",
/// "tessellation" (3 sub-families). Unknown/absent style → classic. An audio
/// always renders in its CREATOR's style (`item.coverStyle`), never the
/// viewer's.
///
/// Rendering: the ground is drawn with CoreGraphics into a bitmap on a
/// background task and cached (see CoverRenderer) — SwiftUI never re-runs the
/// generative math on the main thread. On a cache miss the view shows the
/// style's flat paper/ground color and fades the bitmap in when ready.
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

    @State private var rendered: UIImage?

    private var resolvedStyle: String { CoverArt.resolve(style) }
    /// Classic mesh is a dark ground (scrim + light type); ink and halftone
    /// print on light paper stock (veil + dark ink type). Tessellation stocks
    /// carry their own dark flag.
    private var darkGround: Bool {
        resolvedStyle == "classic"
            || (resolvedStyle == "tessellation" && CoverArt.tessStockFor(id: id).dark)
    }
    private var showsType: Bool { size >= 160 && !(title ?? "").isEmpty }

    private var cacheKey: String {
        CoverRenderer.key(id: id, mood: mood, style: resolvedStyle, emoji: emoji, size: size)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            ground
            if showsType {
                CoverArt.scrim(dark: darkGround)
                typeLayer
            }
        }
        .frame(width: size, height: size)
        .clipped()
    }

    /// Cached bitmap if available (synchronously — a screenful of hits costs
    /// one NSCache lookup each), else the flat ground color while a
    /// background render fills the cache.
    @ViewBuilder private var ground: some View {
        if let ui = CoverRenderer.cached(cacheKey) ?? rendered {
            Image(uiImage: ui)
                .resizable()
                .frame(width: size, height: size)
                .transition(.opacity)
        } else {
            CoverArt.groundColor(id: id, style: resolvedStyle, mood: mood)
                .frame(width: size, height: size)
                .task(id: cacheKey) {
                    let img = await CoverRenderer.image(
                        id: id, mood: mood, style: resolvedStyle, emoji: emoji, size: size)
                    withAnimation(.easeOut(duration: 0.22)) { rendered = img }
                }
        }
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

// MARK: - Bitmap renderer + cache

/// Renders cover grounds to UIImages off the main thread and memoizes them.
/// Everything here is nonisolated: NSCache is thread-safe, the in-flight map
/// is guarded by a lock, and the CG draw code touches no main-actor state.
enum CoverRenderer {
    nonisolated(unsafe) private static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 32 * 1024 * 1024 // bytes (cost = bitmap bytes)
        return c
    }()
    // In-flight renders, deduped so a screenful of one cover renders once.
    nonisolated(unsafe) private static var inflight: [String: Task<UIImage, Never>] = [:]
    private static let lock = NSLock()

    /// Two size buckets: thumbnails (≤120pt requests → 120pt @3x bitmap) and
    /// hero/export sizes (→ 600pt @2x, plenty for a full-width cover).
    static func bucket(for size: CGFloat) -> (points: CGFloat, scale: CGFloat) {
        size <= 120 ? (120, 3) : (600, 2)
    }

    static func key(id: String, mood: String?, style: String, emoji: String?, size: CGFloat) -> String {
        // mood feeds the classic palette, emoji the halftone plates — both are
        // stable per item, but keying on them keeps correctness obvious.
        "\(id)|\(CoverArt.resolve(style))|\(mood ?? "")|\(emoji ?? "")|\(Int(bucket(for: size).points))"
    }

    static func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    /// Await the bitmap: cache hit → immediate; miss → render on a detached
    /// background task (joined by every concurrent requester of the same key).
    static func image(id: String, mood: String?, style: String, emoji: String?, size: CGFloat) async -> UIImage {
        let k = key(id: id, mood: mood, style: style, emoji: emoji, size: size)
        if let hit = cached(k) { return hit }
        return await renderTask(k, id: id, mood: mood, style: style, emoji: emoji, size: size).value
    }

    // Synchronous (NSLock is not async-safe): find or start the render task.
    private static func renderTask(
        _ k: String, id: String, mood: String?, style: String, emoji: String?, size: CGFloat
    ) -> Task<UIImage, Never> {
        let (points, scale) = bucket(for: size)
        lock.lock()
        defer { lock.unlock() }
        if let t = inflight[k] { return t }
        let t = Task<UIImage, Never>.detached(priority: .userInitiated) {
            if let disk = loadDisk(k) {
                finish(k, img: disk, persist: false)
                return disk
            }
            let img = renderGround(id: id, mood: mood, style: style, emoji: emoji,
                                   points: points, scale: scale)
            finish(k, img: img, persist: true)
            return img
        }
        inflight[k] = t
        return t
    }

    // Synchronous for the same reason: store + clear the in-flight entry.
    // persist: write-through to disk for fresh renders (skipped when the
    // bitmap just came FROM disk).
    private static func finish(_ k: String, img: UIImage, persist: Bool) {
        store(img, key: k)
        if persist { saveDisk(img, key: k) }
        lock.lock()
        inflight[k] = nil
        lock.unlock()
    }

    /// Synchronous render-and-cache. For the export paths (lock-screen artwork,
    /// share preview) that rasterize CoverView with ImageRenderer: warming the
    /// cache first means ImageRenderer captures the real art, not the async
    /// placeholder. Off the scroll hot path — blocking is fine there.
    @discardableResult
    static func prewarm(id: String, mood: String?, style: String, emoji: String?, size: CGFloat) -> UIImage {
        let k = key(id: id, mood: mood, style: style, emoji: emoji, size: size)
        if let hit = cached(k) { return hit }
        if let disk = loadDisk(k) {
            store(disk, key: k)
            return disk
        }
        let (points, scale) = bucket(for: size)
        let img = renderGround(id: id, mood: mood, style: style, emoji: emoji,
                               points: points, scale: scale)
        store(img, key: k)
        saveDisk(img, key: k)
        return img
    }

    private static func store(_ img: UIImage, key: String) {
        let px = img.size.width * img.scale * img.size.height * img.scale
        cache.setObject(img, forKey: key as NSString, cost: Int(px) * 4)
    }

    // MARK: Disk layer — Caches/covers/*.png, named by the cache key. Covers
    // are regenerable, so they belong in the system-purgeable Caches dir
    // (survives relaunch, never backed up, wiped by the OS under pressure).
    // ponytail: no eviction of our own — a few hundred small PNGs at most,
    // and the OS purges Caches; add LRU trimming only if it ever matters.

    nonisolated(unsafe) private static let diskDir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("covers", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private static func diskURL(_ key: String) -> URL {
        diskDir.appendingPathComponent(key.replacingOccurrences(of: "/", with: "_") + ".png")
    }

    private static func loadDisk(_ key: String) -> UIImage? {
        UIImage(contentsOfFile: diskURL(key).path)
    }

    private static func saveDisk(_ img: UIImage, key: String) {
        try? img.pngData()?.write(to: diskURL(key), options: .atomic)
    }

    /// Pure CG draw into a bitmap — safe on any thread.
    private static func renderGround(
        id: String, mood: String?, style: String, emoji: String?,
        points: CGFloat, scale: CGFloat
    ) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = scale
        fmt.opaque = true // every style fills the full square first
        return UIGraphicsImageRenderer(size: CGSize(width: points, height: points), format: fmt)
            .image { rctx in
                let c = rctx.cgContext
                let s = Double(points)
                switch CoverArt.resolve(style) {
                case "ink":
                    CoverArt.drawInk(c, s: s, id: id)
                case "halftone":
                    CoverArt.drawHalftone(c, s: s, id: id, emoji: emoji)
                case "tessellation":
                    CoverArt.drawTessellation(c, s: s, id: id)
                default:
                    CoverArt.drawClassic(c, s: s, id: id, mood: mood)
                }
            }
    }
}

enum CoverArt {
    static let tau = Double.pi * 2

    static func resolve(_ style: String) -> String {
        ["ink", "halftone", "tessellation"].contains(style) ? style : "classic"
    }

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

    private static func cgColor(_ hex: Int, alpha: Double = 1) -> CGColor {
        CGColor(
            srgbRed: Double((hex >> 16) & 0xff) / 255,
            green:   Double((hex >> 8) & 0xff) / 255,
            blue:    Double(hex & 0xff) / 255,
            alpha:   alpha
        )
    }

    private static func squareRect(_ s: Double) -> CGRect {
        CGRect(x: 0, y: 0, width: s, height: s)
    }

    private static func circleRect(_ cx: Double, _ cy: Double, _ r: Double) -> CGRect {
        CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
    }

    /// The style's flat ground/paper color — the pre-render placeholder. Pulls
    /// only as far into the PRNG stream as each style's own paper choice, in
    /// the exact same order the full renderer does.
    static func groundColor(id: String, style: String, mood: String?) -> Color {
        var rng = Mulberry32(seed: fnv1a(id))
        switch resolve(style) {
        case "ink":
            _ = rng.next() // family pull comes first in drawInk
            return color(pick(&rng, inkStock).paper)
        case "halftone":
            return color(pick(&rng, htInks).paper)
        case "tessellation":
            _ = rng.next() // family pull comes first in drawTessellation
            return color(pick(&rng, tessStock).a)
        default:
            return palette(id: id, mood: mood)[2]
        }
    }

    // MARK: - Classic mesh (unchanged math — bit-for-bit with the original)

    // mood → three hex colors. Order of the fallback list is load-bearing.
    private static let palettes: [String: [Int]] = [
        "calm":      [0x1d9e75, 0x0f6e56, 0x378add],
        "energetic": [0xf5a623, 0xd85a30, 0xef9f27],
        "serious":   [0x534ab7, 0x185fa5, 0x3c3489],
        "playful":   [0xd4537e, 0x7f77dd, 0xed93b1],
        "warm":      [0xd85a30, 0xf5a623, 0x993c1d],
    ]
    private static let fallbackOrder = ["warm", "calm", "energetic", "serious", "playful"]

    static func paletteHex(id: String, mood: String?) -> [Int] {
        if let m = mood, !m.isEmpty, let hit = palettes[m] { return hit }
        return palettes[fallbackOrder[Int(fnv1a(id) % 5)]]!
    }

    static func palette(id: String, mood: String?) -> [Color] {
        paletteHex(id: id, mood: mood).map(color(_:))
    }

    static func drawClassic(_ c: CGContext, s: Double, id: String, mood: String?) {
        let pal = paletteHex(id: id, mood: mood)
        c.setFillColor(cgColor(pal[2]))
        c.fill(squareRect(s))

        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        var rng = Mulberry32(seed: fnv1a(id))
        for i in 0..<7 {
            let x = rng.next() * s
            let y = rng.next() * s
            let r = s * (0.35 + rng.next() * 0.5)
            let hex = pal[i % 3]
            // Soft blob: color at the center fading to the same color at
            // alpha 0 — identical to the canvas/SwiftUI radial ramp.
            guard let grad = CGGradient(
                colorsSpace: srgb,
                colors: [cgColor(hex), cgColor(hex, alpha: 0)] as CFArray,
                locations: [0, 1]
            ) else { continue }
            let center = CGPoint(x: x, y: y)
            c.drawRadialGradient(grad, startCenter: center, startRadius: 0,
                                 endCenter: center, endRadius: r, options: [])
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

    static func drawInk(_ c: CGContext, s: Double, id: String) {
        var rng = Mulberry32(seed: fnv1a(id))
        // FIRST pull selects the sub-family, then that family draws with the same rng.
        let family = Int(rng.next() * 4)
        switch family {
        case 0: inkRings(c, s, &rng)
        case 1: inkContours(c, s, &rng)
        case 2: inkBurst(c, s, &rng)
        default: inkHex(c, s, &rng)
        }
    }

    /// Paper fill + 6.5% poster-margin clip (left applied on the context —
    /// each family draws once into a fresh bitmap context, nothing restores).
    private static func inkStart(
        _ c: CGContext, _ s: Double, _ rng: inout Mulberry32
    ) -> (paper: Int, ink: Int) {
        let st = pick(&rng, inkStock)
        c.setFillColor(cgColor(st.paper))
        c.fill(squareRect(s))
        let m = s * 0.065
        c.clip(to: CGRect(x: m, y: m, width: s - 2 * m, height: s - 2 * m))
        return st
    }

    private static func inkRings(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let (_, ink) = inkStart(c, s, &rng)
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
        c.addEllipse(in: circleRect(cx, cy, rad))
        c.clip()
        c.setStrokeColor(cgColor(ink))
        c.setLineWidth(lw)
        for i in 1...rings {
            let k = Double(i) / Double(rings)
            let ocx = cx + cos(dir) * drift * k
            let ocy = cy + sin(dir) * drift * k
            c.strokeEllipse(in: circleRect(ocx, ocy, gap * Double(i) - lw * 0.5))
        }
        c.setFillColor(cgColor(ink))
        c.fillEllipse(in: circleRect(cx, cy, gap * 0.55)) // focal: the solid eye
    }

    private static func inkContours(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let (_, ink) = inkStart(c, s, &rng)
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
        c.setFillColor(cgColor(ink))
        var k = -2
        while k < bands {
            let path = CGMutablePath()
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
            c.addPath(path)
            c.fillPath(using: .evenOdd)
            k += 2
        }
    }

    private static func inkBurst(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let (paper, ink) = inkStart(c, s, &rng)
        let edge = rng.next() < 0.45
        let ox = s * (edge ? (rng.next() < 0.5 ? 0.08 : 0.92) : 0.5 + (rng.next() - 0.5) * 0.14)
        let oy = s * (edge ? 0.5 + (rng.next() - 0.5) * 0.6 : 0.5 + (rng.next() - 0.5) * 0.14)
        let spokes = 14 + Int(rng.next() * 16) * 2
        _ = rng.next() // spin — t only
        let ph = rng.next() * tau
        let thin = 0.16 + rng.next() * 0.16
        c.setFillColor(cgColor(ink))
        for i in 0..<spokes {
            let a0 = ph + Double(i) / Double(spokes) * tau
            // JS pulls R only for even spokes — preserve that order exactly.
            let w = tau / Double(spokes) * (i % 2 == 1 ? thin : 0.40 + rng.next() * 0.12)
            let path = CGMutablePath()
            path.move(to: CGPoint(x: ox, y: oy))
            // The arc at r = 1.6s lies entirely off-canvas; a polyline arc
            // avoids any addArc winding ambiguity.
            for j in 0...8 {
                let an = a0 + w * Double(j) / 8
                path.addLine(to: CGPoint(x: ox + cos(an) * s * 1.6, y: oy + sin(an) * s * 1.6))
            }
            path.closeSubpath()
            c.addPath(path)
            c.fillPath()
        }
        let rr = s * (0.10 + rng.next() * 0.07) // focal: hub + hairline
        c.setFillColor(cgColor(paper))
        c.fillEllipse(in: circleRect(ox, oy, rr))
        c.setStrokeColor(cgColor(ink))
        c.setLineWidth(s * 0.012)
        c.strokeEllipse(in: circleRect(ox, oy, rr * (1.45 + 0.05 * sin(ph))))
    }

    private static func inkHex(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let (_, ink) = inkStart(c, s, &rng)
        let r = s * (0.055 + rng.next() * 0.035)
        let lw = r * 0.13 // t = 0: the .02·sin breath term is 0
        let dx = r * 1.732, dy = r * 1.5
        let cols = Int(ceil(s / dx)) + 2, rows = Int(ceil(s / dy)) + 2
        let fx = s * (0.25 + rng.next() * 0.5)
        let fy = s * (0.25 + rng.next() * 0.5)
        let fr = r * (1.2 + rng.next() * 0.9)
        // drift = sin(0)·.5 = 0
        c.setFillColor(cgColor(ink))
        c.setStrokeColor(cgColor(ink))
        c.setLineWidth(lw)
        c.setLineJoin(.round)
        for j in -1..<rows {
            for i in -1..<cols {
                let hx = Double(i) * dx + (j & 1 == 1 ? dx / 2 : 0)
                let hy = Double(j) * dy
                let path = CGMutablePath()
                for k in 0..<6 {
                    let an = Double(k) * tau / 6 + .pi / 6
                    let pt = CGPoint(x: hx + cos(an) * r * 0.94, y: hy + sin(an) * r * 0.94)
                    if k == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                }
                path.closeSubpath()
                if ((hx - fx) * (hx - fx) + (hy - fy) * (hy - fy)).squareRoot() < fr {
                    c.addPath(path)
                    c.fillPath() // focal cluster
                }
                c.addPath(path)
                c.strokePath()
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

    static func drawHalftone(_ c: CGContext, s: Double, id: String, emoji: String?) {
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

        c.setFillColor(cgColor(set.paper))
        c.fill(squareRect(s))
        // t = 0 evaluations of the breathing/turn terms.
        let zm = zoom * (1 + 0.045 * sin(brz))
        let rt = spin + 0.05 * sin(dph)
        let cr = cos(rt) / zm, sr = sin(rt) / zm
        let px0 = shx + 0.012 * sin(dph)
        let py0 = shy + 0.012 * cos(brz)
        let reach = Int(ceil(s * 0.78 / pitch))
        for k in 0..<3 {
            let ca = cos(ang[k]), sa = sin(ang[k])
            let path = CGMutablePath()
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
            // One fill per plate (matches the GraphicsContext layer-copy):
            // multiply blend + plate opacity applied to the whole dot path.
            c.saveGState()
            c.setBlendMode(.multiply)
            c.setAlpha(k == 2 ? 0.92 : 0.85)
            c.setFillColor(cgColor(set.inks[k]))
            c.addPath(path)
            c.fillPath()
            c.restoreGState()
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

    // nonisolated(unsafe): every access is guarded by densLock below (renders
    // now run on background tasks, so the lock is load-bearing).
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

    /// One harmonic blob printed as a mis-registered duotone — the SAME pure
    /// math as ui/src/covers.ts / src/share.ts blobDensity (analytic binary
    /// coverage + 3× box blur), so the no-emoji halftone lattice matches web
    /// and server dot-for-dot. (The canvas lab's straight-alpha read-back
    /// cancels alpha, so each plate is its own coverage times a weight.)
    private static func blobDensity(_ rng: inout Mulberry32) -> [[Float]] {
        let w = htw, count = w * w
        let cx = Double(w) * (0.44 + rng.next() * 0.12)
        let cy = Double(w) * (0.44 + rng.next() * 0.12)
        let rad = Double(w) * (0.30 + rng.next() * 0.07)
        let h0 = rng.next() * tau, h1 = rng.next() * tau, h2 = rng.next() * tau
        // (dx, dy, scale) per plate — R, G, B in the JS.
        let plates: [(Double, Double, Double)] = [
            (-rad * 0.045, -rad * 0.03, 1.0),
            (rad * 0.05, rad * 0.035, 0.96),
            (rad * 0.14, rad * 0.13, 0.62),
        ]
        var dens = [[Float]](repeating: [Float](repeating: 0, count: count), count: 3)
        for (p, (pdx, pdy, k)) in plates.enumerated() {
            var cov = [Float](repeating: 0, count: count)
            for y in 0..<w {
                for x in 0..<w {
                    let px = Double(x) + 0.5 - cx - pdx
                    let py = Double(y) + 0.5 - cy - pdy
                    let th = atan2(py, px)
                    let rr = rad * k * (1 + 0.24 * sin(3 * th + h0) + 0.13 * sin(5 * th + h1) + 0.08 * sin(7 * th + h2))
                    if px * px + py * py <= rr * rr { cov[y * w + x] = 1 }
                }
            }
            boxBlur(&cov)
            boxBlur(&cov)
            boxBlur(&cov)
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

    /// Separable box blur (radius 2), run 3× — the JS twins' boxBlur, verbatim.
    private static func boxBlur(_ buf: inout [Float]) {
        let r = 2, w = htw
        var tmp = [Float](repeating: 0, count: buf.count)
        for y in 0..<w {
            for x in 0..<w {
                var sum = 0.0
                var n = 0.0
                for k in -r...r {
                    let xx = x + k
                    if xx >= 0 && xx < w {
                        sum += Double(buf[y * w + xx])
                        n += 1
                    }
                }
                tmp[y * w + x] = Float(sum / n)
            }
        }
        for y in 0..<w {
            for x in 0..<w {
                var sum = 0.0
                var n = 0.0
                for k in -r...r {
                    let yy = y + k
                    if yy >= 0 && yy < w {
                        sum += Double(tmp[yy * w + x])
                        n += 1
                    }
                }
                buf[y * w + x] = Float(sum / n)
            }
        }
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

    // MARK: - Tessellation (lab: tessWeave/tessReptile/tessPinwheel, t = 0)

    private static let tessSeg = 12

    /// Curated tile stocks — copied verbatim from the lab's TESS_STOCK.
    /// a/b/c = tile fills (c only for the hex 3-colouring), l = hairline ink,
    /// dark = dark ground (drives scrim vs paper veil under the type layer).
    static let tessStock: [(a: Int, b: Int, c: Int, l: Int, dark: Bool)] = [
        (0xF4F7EE, 0xAACF53, 0x7BA428, 0x2C3B18, false), // moegi on byakuroku
        (0xF1EBDC, 0x33312E, 0x595857, 0x15130F, false), // sumi woodcut
        (0xFAFCF5, 0x2A5FB0, 0x12305C, 0x12141C, false), // ruri on gofun
        (0x04141F, 0x007BBB, 0x004C71, 0x020A10, true),  // ai night
        (0xF2EDDF, 0x9E3D3F, 0xBF783A, 0x43261F, false), // suo on cream
        (0x15130F, 0x595857, 0xF1EBDC, 0x0C0D09, true),  // sumi night
        (0xF2EDDF, 0xD3381C, 0xEB6101, 0x43261F, false), // hi on cream
        (0x120C18, 0x745399, 0x3A2A55, 0x09060C, true),  // edomurasaki dusk
    ]

    /// The stock this id's tessellation lands on — replays only the two cheap
    /// leading pulls (family, stock) for the placeholder ground + dark flag.
    static func tessStockFor(id: String) -> (a: Int, b: Int, c: Int, l: Int, dark: Bool) {
        var rng = Mulberry32(seed: fnv1a(id))
        _ = rng.next() // family
        return pick(&rng, tessStock)
    }

    static func drawTessellation(_ c: CGContext, s: Double, id: String) {
        var rng = Mulberry32(seed: fnv1a(id))
        // FIRST pull selects the sub-family, then that family draws with the same rng.
        let family = Int(rng.next() * 3)
        switch family {
        case 0: tessWeave(c, s, &rng)
        case 1: tessReptile(c, s, &rng)
        default: tessPinwheel(c, s, &rng)
        }
    }

    /// JS vhash — 32-bit wrapping integer hash, bit-for-bit with Math.imul.
    private static func vhash(_ ix: Int32, _ iy: Int32, _ sd: Int32) -> Double {
        var h = UInt32(bitPattern: ix &* 374761393 &+ iy &* 668265263 &+ sd)
        h = (h ^ (h >> 13)) &* 1274126177
        return Double(h ^ (h >> 16)) / 4294967296
    }

    /// Seeded three-harmonic edge profile, normalized so max|g| = 1 over
    /// u = i/32, i = 1..31 (exact sampling — part of the porting contract).
    /// Three pulls: c1, c2, c3. g(0) = g(1) = 0, so corners stay fixed.
    private static func tessProfile(_ rng: inout Mulberry32) -> (Double) -> Double {
        let c1 = (rng.next() * 2 - 1) * 0.6
        let c2 = rng.next() * 2 - 1
        let c3 = (rng.next() * 2 - 1) * 0.4
        var m = 0.0
        for i in 1..<32 {
            let u = Double(i) / 32
            m = max(m, abs(c1 * sin(.pi * u) + c2 * sin(tau * u) + c3 * sin(3 * .pi * u)))
        }
        let k = 1 / (m == 0 ? 1 : m)
        return { u in (c1 * sin(.pi * u) + c2 * sin(tau * u) + c3 * sin(3 * .pi * u)) * k }
    }

    /// Paper fill (no margin clip — tessellations run full bleed). One pull.
    private static func tessStart(
        _ c: CGContext, _ s: Double, _ rng: inout Mulberry32
    ) -> (a: Int, b: Int, c: Int, l: Int, dark: Bool) {
        let st = pick(&rng, tessStock)
        c.setFillColor(cgColor(st.a))
        c.fill(squareRect(s))
        return st
    }

    /// Colouring modes: 0 checkerboard (hex: proper 3-colouring), 1 row
    /// stripes, 2 quiet field with sparse accent tiles. tri = hex lattice.
    private static func tessColorHex(
        _ st: (a: Int, b: Int, c: Int, l: Int, dark: Bool),
        _ mode: Int, _ i: Int, _ j: Int, _ tri: Bool, _ sd: Int32
    ) -> Int {
        if mode == 1 { return ((j % 2) + 2) % 2 == 1 ? st.b : st.a }
        if mode == 2 {
            let h = vhash(Int32(i + 211), Int32(j + 57), sd)
            return h < 0.14 ? st.b : (tri && h < 0.20 ? st.c : st.a)
        }
        if tri { return [st.a, st.b, st.c][((i - j) % 3 + 3) % 3] }
        return ((i + j) % 2 + 2) % 2 == 1 ? st.b : st.a
    }

    /// tessShade — per-tile flat lightness jitter (JS toRGB + css, including
    /// the `| 0` channel truncation, so fills match the web to the rgb unit).
    private static func tessShadeColor(_ hex: Int, _ i: Int, _ j: Int, _ sd: Int32) -> CGColor {
        let k = (vhash(Int32(i + 37), Int32(j + 91), sd) - 0.5) * 0.16
        let tgt: Double = k < 0 ? 0 : 255
        let m = abs(k)
        func ch(_ sh: Int) -> Double {
            let v = Double((hex >> sh) & 255)
            return Double(Int(v + (tgt - v) * m)) / 255
        }
        return CGColor(srgbRed: ch(16), green: ch(8), blue: ch(0), alpha: 1)
    }

    /// One tile: fill then hairline stroke sealing the seam.
    private static func tessCell(
        _ c: CGContext, _ pts: [(Double, Double)], fill: CGColor, line: CGColor, lw: Double
    ) {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: pts[0].0, y: pts[0].1))
        for p in pts.dropFirst() { path.addLine(to: CGPoint(x: p.0, y: p.1)) }
        path.closeSubpath()
        c.addPath(path)
        c.setFillColor(fill)
        c.fillPath()
        c.addPath(path)
        c.setStrokeColor(line)
        c.setLineWidth(lw)
        c.strokePath()
    }

    /// Square lattice, p1 translation: what bulges out of the bottom edge is
    /// carved into the top; ditto left/right. Fine fabric — 8..12 cells.
    private static func tessWeave(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let st = tessStart(c, s, &rng)
        let mode = Int(rng.next() * 3)
        let n = 8 + Int(rng.next() * 5)
        let cell = s / Double(n)
        let rot0 = rng.next() * .pi / 2
        let ampF = 0.07 + rng.next() * 0.08
        let gH = tessProfile(&rng), gV = tessProfile(&rng)
        let ph = rng.next() * tau
        let sd = Int32(rng.next() * 2147483647)
        let a = ampF * cell * (1 + 0.05 * sin(ph)) // t = 0 breathing
        let lw = max(0.75, cell * 0.03)
        let m = Int(ceil(Double(n) * 0.75)) + 1
        c.saveGState()
        c.translateBy(x: s / 2, y: s / 2)
        c.rotate(by: rot0)
        c.setLineJoin(.round)
        let seg = Double(tessSeg)
        for j in -m..<m {
            for i in -m..<m {
                let ox = Double(i) * cell, oy = Double(j) * cell
                if hypot(ox + cell / 2, oy + cell / 2) > s * 0.72 + cell { continue }
                var p: [(Double, Double)] = []
                for k in 0...tessSeg { let u = Double(k) / seg; p.append((ox + u * cell, oy + gH(u) * a)) }
                for k in 1...tessSeg { let v = Double(k) / seg; p.append((ox + cell + gV(v) * a, oy + v * cell)) }
                for k in stride(from: tessSeg - 1, through: 0, by: -1) {
                    let u = Double(k) / seg
                    p.append((ox + u * cell, oy + cell + gH(u) * a))
                }
                for k in stride(from: tessSeg - 1, through: 1, by: -1) {
                    let v = Double(k) / seg
                    p.append((ox + gV(v) * a, oy + v * cell))
                }
                tessCell(c, p, fill: tessShadeColor(tessColorHex(st, mode, i, j, false, sd), i, j, sd),
                         line: cgColor(st.l), lw: lw)
            }
        }
        c.restoreGState()
    }

    /// Hex lattice, translation (Escher's reptiles): three free edge curves,
    /// replayed reversed on the opposite edges. Proper 3-colouring.
    private static func tessReptile(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let st = tessStart(c, s, &rng)
        let mode = Int(rng.next() * 3)
        let n = 3 + Int(rng.next() * 4)
        let rr = s / (1.732 * Double(n))
        let rot0 = rng.next() * .pi / 2
        let ampF = 0.14 + rng.next() * 0.12
        let prof = [tessProfile(&rng), tessProfile(&rng), tessProfile(&rng)]
        let ph = rng.next() * tau
        let sd = Int32(rng.next() * 2147483647)
        let a = ampF * rr * (1 + 0.05 * sin(ph))
        let lw = max(0.75, rr * 0.05)
        // Pointy-top hexagon, vertices at 90 + 60k deg.
        var V: [(Double, Double)] = []
        for k in 0..<6 {
            let an = Double(90 + 60 * k) * .pi / 180
            V.append((rr * cos(an), rr * sin(an)))
        }
        // Base curves on edges 0..2; the perpendicular is fixed per edge so
        // the mating edge reuses the SAME computed points, just translated.
        var E: [[(Double, Double)]] = []
        for k in 0..<3 {
            let A = V[k], B = V[k + 1]
            let dx = B.0 - A.0, dy = B.1 - A.1, len = hypot(dx, dy)
            let nx = -dy / len, ny = dx / len
            var pts: [(Double, Double)] = []
            for q in 0...tessSeg {
                let u = Double(q) / Double(tessSeg)
                let f = prof[k](u) * a
                pts.append((A.0 + dx * u + nx * f, A.1 + dy * u + ny * f))
            }
            E.append(pts)
        }
        var D: [(Double, Double)] = []
        for k in 0..<3 { D.append((V[k].0 + V[k + 1].0, V[k].1 + V[k + 1].1)) }
        // One closed outline, built once (derived edges 3,4 include the end
        // corner q = 0; edge 5 stops at q = 1 — closePath supplies the rest).
        var tile: [(Double, Double)] = []
        for k in 0..<3 {
            for q in (k > 0 ? 1 : 0)...tessSeg { tile.append(E[k][q]) }
        }
        for k in 0..<3 {
            for q in stride(from: tessSeg - 1, through: k < 2 ? 0 : 1, by: -1) {
                tile.append((E[k][q].0 - D[k].0, E[k][q].1 - D[k].1))
            }
        }
        let mj = Int(ceil(s * 0.75 / (1.5 * rr))) + 1
        let mi = Int(ceil(s * 0.75 / (1.732 * rr))) + 2
        c.saveGState()
        c.translateBy(x: s / 2, y: s / 2)
        c.rotate(by: rot0)
        c.setLineJoin(.round)
        for j in -mj...mj {
            for i in (-mi - 2)...(mi + 2) {
                let cx = 1.732 * rr * (Double(i) + Double(j) / 2)
                let cy = 1.5 * rr * Double(j)
                if hypot(cx, cy) > s * 0.74 + 2 * rr { continue }
                let base = tessColorHex(st, mode, i, j, true, sd)
                tessCell(c, tile.map { ($0.0 + cx, $0.1 + cy) },
                         fill: tessShadeColor(base, i, j, sd), line: cgColor(st.l), lw: lw)
            }
        }
        c.restoreGState()
    }

    /// Square lattice, p4 rotation (Escher's lizards): edge AB free, BC is AB
    /// rotated -90 deg about B; CD free, DA is CD rotated -90 deg about D.
    /// Four rotated copies pinwheel around alternating corners.
    private static func tessPinwheel(_ c: CGContext, _ s: Double, _ rng: inout Mulberry32) {
        let st = tessStart(c, s, &rng)
        let mode = Int(rng.next() * 3)
        let n = 2 + Int(rng.next() * 3)
        let cell = s / Double(n)
        let rot0 = rng.next() * .pi / 2
        let ampF = 0.16 + rng.next() * 0.10
        let g1 = tessProfile(&rng), g2 = tessProfile(&rng)
        let ph = rng.next() * tau
        let sd = Int32(rng.next() * 2147483647)
        let a = ampF * (1 + 0.05 * sin(ph)) // unit-cell space
        let lw = max(0.75, cell * 0.03)
        let seg = Double(tessSeg)
        var base: [(Double, Double)] = []
        for k in 0...tessSeg { let u = Double(k) / seg; base.append((u, g1(u) * a)) }
        for k in stride(from: tessSeg - 1, through: 0, by: -1) {
            let u = Double(k) / seg
            base.append((1 + g1(u) * a, 1 - u))
        }
        for k in 1...tessSeg { let u = Double(k) / seg; base.append((1 - u, 1 + g2(u) * a)) }
        for k in stride(from: tessSeg - 1, through: 1, by: -1) {
            let u = Double(k) / seg
            base.append((g2(u) * a, u))
        }
        // rho(x, y) = (1 + y, 1 - x) in cell units.
        var variants = [base]
        for r in 1..<4 { variants.append(variants[r - 1].map { (1 + $0.1, 1 - $0.0) }) }
        let OX = [0, 1, 1, 0], OY = [0, 0, -1, -1], RIDX = [[0, 3], [1, 2]]
        let m = Int(ceil(Double(n) * 0.75)) + 1
        c.saveGState()
        c.translateBy(x: s / 2, y: s / 2)
        c.rotate(by: rot0)
        c.setLineJoin(.round)
        for j in -m..<m {
            for i in -m..<m {
                if hypot((Double(i) + 0.5) * cell, (Double(j) + 0.5) * cell) > s * 0.72 + cell * (1 + ampF) { continue }
                let r = RIDX[((i % 2) + 2) % 2][((j % 2) + 2) % 2]
                let tx = Double(i - OX[r]), ty = Double(j - OY[r])
                let pts = variants[r].map { (($0.0 + tx) * cell, ($0.1 + ty) * cell) }
                tessCell(c, pts, fill: tessShadeColor(tessColorHex(st, mode, i, j, false, sd), i, j, sd),
                         line: cgColor(st.l), lw: lw)
            }
        }
        c.restoreGState()
    }

    // MARK: - Scrim / veil under the editorial type (lab: coverScrim)

    /// Same stops the Canvas scrim used — a plain SwiftUI gradient now, since
    /// only the ground raster moved into the cached bitmap.
    static func scrim(dark: Bool) -> LinearGradient {
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
        return LinearGradient(stops: stops, startPoint: .top, endPoint: .bottom)
    }
}

// MARK: - Style picker (shared by onboarding and Settings)

/// Live preview tiles — tap to select. The previews use one fixed sample
/// id so each style shows its real seeded output. 2×2 grid: four 96pt tiles
/// no longer fit one row on compact widths.
struct CoverStylePicker: View {
    @Binding var selection: String
    var tileSize: CGFloat = 96

    static let styles: [(id: String, label: String)] = [
        ("classic", "Classic"), ("ink", "Ink"),
        ("halftone", "Halftone"), ("tessellation", "Tessellation"),
    ]

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.fixed(tileSize), spacing: 14), GridItem(.fixed(tileSize), spacing: 14)],
            spacing: 14
        ) {
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
