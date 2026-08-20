import SwiftUI

/// States the orb can express. Communicated purely through motion, shape and color.
enum VoiceOrbState: CaseIterable {
    case idle, listening, thinking, speaking
}

/// Organic liquid-gradient orb for the voice UI. Fills its container (give it a
/// square-ish frame, ~72–120pt). Drive `level` (normalized 0–1) from the mic
/// while `.listening` and from the output audio envelope while `.speaking`.
/// State changes crossfade — parameters interpolate, nothing cuts.
/// Removal: wrap show/hide in `withAnimation` and the orb collapses + dissolves.
struct VoiceOrbView: View {
    var state: VoiceOrbState
    var level: Double = 0
    var palette: [Color]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var engine = OrbEngine()

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { ctx, size in
                let p = engine.step(
                    now: timeline.date.timeIntervalSinceReferenceDate,
                    state: state,
                    raw: min(max(level, 0), 1),
                    reduceMotion: reduceMotion
                )
                draw(p, in: &ctx, size: size)
            }
        }
        .transition(.asymmetric(
            insertion: .opacity,  // scale-in with overshoot is handled internally
            removal: .scale(scale: 0.05).combined(with: .opacity)
        ))
    }

    private func draw(_ p: OrbParams, in ctx: inout GraphicsContext, size: CGSize) {
        let colors = palette.isEmpty ? [Color.blue, .purple] : palette
        let cx = Double(size.width) / 2, cy = Double(size.height) / 2
        let r = Double(min(size.width, size.height)) / 2 * 0.74 * p.scale

        ctx.opacity = p.alpha

        // Deforming outline: 8 points whose radii are wobbled by summed sines at
        // incommensurate frequencies (0.7 / 1.31 / 2.17 Hz) with golden-angle
        // phase offsets, so the silhouette never visibly repeats.
        var pts: [CGPoint] = []
        for i in 0..<8 {
            let a = Double(i) / 8 * 2 * .pi
            let seed = Double(i) * 2.39996
            var w = sin(p.t * 0.7 * 2 * .pi + seed * 1.7) * 0.5
                  + sin(p.t * 1.31 * 2 * .pi + seed * 3.1) * 0.33
                  + sin(p.t * 2.17 * 2 * .pi + seed * 5.3) * 0.17
            w *= 1 + p.asym * 0.7 * sin(seed + p.t * 0.41)  // asymmetry while speaking
            let ri = r * (1 + p.deform * w)
            pts.append(CGPoint(x: cx + cos(a) * ri, y: cy + sin(a) * ri))
        }
        var outline = Path()
        outline.move(to: pts[0])
        for i in 0..<8 {  // closed Catmull-Rom -> cubic Bézier
            let p0 = pts[(i + 7) % 8], p1 = pts[i], p2 = pts[(i + 1) % 8], p3 = pts[(i + 2) % 8]
            outline.addCurve(
                to: p2,
                control1: CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                control2: CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            )
        }
        outline.closeSubpath()

        // Halo: the outline itself, heavily blurred — breathes with the shape.
        var halo = ctx
        halo.addFilter(.blur(radius: r * 0.22))
        halo.fill(outline, with: .color(colors[0].opacity(p.glow)))

        // Everything below is clipped inside the orb.
        var inner = ctx
        inner.clip(to: outline)
        inner.addFilter(.saturation(p.sat))
        inner.addFilter(.brightness(p.bright))

        // Base gradient, rotating (slow drift normally, fast while thinking).
        let dx = cos(p.rotPhase), dy = sin(p.rotPhase)
        inner.fill(outline, with: .linearGradient(
            Gradient(colors: colors),
            startPoint: CGPoint(x: cx - dx * r, y: cy - dy * r),
            endPoint: CGPoint(x: cx + dx * r, y: cy + dy * r)
        ))

        // Ink-in-water blobs: blurred radial gradients drifting at different rates.
        var blobs = inner
        blobs.blendMode = .screen
        blobs.addFilter(.blur(radius: r * 0.16))
        for i in 0..<4 {
            let f = Double(i)
            let col = colors[i % colors.count]
            let bx = cx + cos(p.innerPhase * (0.53 + 0.19 * f) + f * 2.4) * r * 0.38
            let by = cy + sin(p.innerPhase * (0.71 + 0.13 * f) + f * 1.3 + 0.9) * r * 0.38
            let br = r * (0.55 + 0.12 * sin(p.innerPhase * 0.37 + f * 1.9))
            blobs.fill(
                Path(ellipseIn: CGRect(x: bx - br, y: by - br, width: br * 2, height: br * 2)),
                with: .radialGradient(
                    Gradient(colors: [col.opacity(0.85), col.opacity(0)]),
                    center: CGPoint(x: bx, y: by), startRadius: 0, endRadius: br
                )
            )
        }

        // Soft concentric ripples on voice peaks (listening).
        for age in p.ripples {
            let f = age / 0.9
            let rr = r * (0.25 + 0.85 * f)
            var rip = inner
            rip.blendMode = .screen
            rip.stroke(
                Path(ellipseIn: CGRect(x: cx - rr, y: cy - rr, width: rr * 2, height: rr * 2)),
                with: .color(.white.opacity(0.28 * (1 - f))),
                lineWidth: 1.5
            )
        }

        // Drifting internal light point (speaking) — the sound source.
        if p.spot > 0.01 {
            let sx = cx + cos(p.t * 0.9) * sin(p.t * 0.53) * r * 0.4
            let sy = cy + sin(p.t * 0.74) * r * 0.4
            var spot = inner
            spot.blendMode = .plusLighter
            spot.fill(
                Path(ellipseIn: CGRect(x: sx - r * 0.35, y: sy - r * 0.35, width: r * 0.7, height: r * 0.7)),
                with: .radialGradient(
                    Gradient(colors: [.white.opacity(0.55 * p.spot), .white.opacity(0)]),
                    center: CGPoint(x: sx, y: sy), startRadius: 0, endRadius: r * 0.35
                )
            )
        }
    }
}

/// Snapshot of everything the draw pass needs for one frame.
private struct OrbParams {
    var t = 0.0, scale = 1.0, deform = 0.0, asym = 0.0
    var innerPhase = 0.0, rotPhase = 0.0
    var sat = 1.0, bright = 0.0, glow = 0.3, spot = 0.0
    var alpha = 1.0
    var ripples: [Double] = []  // ages in seconds
}

// ponytail: plain class mutated inside the Canvas render closure — per-frame
// animation state stays out of SwiftUI invalidation entirely (no @State churn).
private final class OrbEngine {
    private var last: TimeInterval?
    private var born: TimeInterval?
    private var level = 0.0, levelVel = 0.0, prevRaw = 0.0
    private var lastRipple: TimeInterval = 0
    private var ripples: [TimeInterval] = []  // birth times
    private var innerPhase = 0.0, rotPhase = 0.0
    // Smoothed state parameters — lerped toward per-state targets so state
    // changes crossfade over ~0.4–0.8s instead of cutting.
    private var deform = 0.02, asym = 0.0, innerSpeed = 0.45, rotSpeed = 0.06
    private var sat = 0.8, bright = 0.0, glow = 0.3, base = 1.0
    private var levelGain = 0.0, deformGain = 0.0, glowGain = 0.0, spot = 0.0

    func step(now: TimeInterval, state: VoiceOrbState, raw: Double, reduceMotion: Bool) -> OrbParams {
        let dt = min(now - (last ?? now), 1.0 / 20)
        last = now
        if born == nil { born = now }
        let age = now - born!

        // Per-state targets:            deform asym  spin  rot   sat  brt  glow  base  lvlG  defG  glwG spot
        let tg: (deform: Double, asym: Double, innerSpeed: Double, rotSpeed: Double,
                 sat: Double, bright: Double, glow: Double, base: Double,
                 levelGain: Double, deformGain: Double, glowGain: Double, spot: Double)
        switch state {
        case .idle:      tg = (0.020, 0.0, 0.45, 0.06, 0.80, 0.00, 0.30, 1.00, 0.00, 0.00, 0.00, 0)
        case .listening: tg = (0.045, 0.2, 0.95, 0.10, 1.25, 0.04, 0.42, 1.00, 0.12, 0.06, 0.30, 0)
        case .thinking:  tg = (0.012, 0.0, 2.80, 0.85, 1.05, 0.02, 0.36, 0.92, 0.00, 0.00, 0.00, 0)
        case .speaking:  tg = (0.055, 1.0, 1.50, 0.14, 1.20, 0.10, 0.45, 1.02, 0.16, 0.09, 0.35, 1)
        }

        let k = 1 - exp(-dt / 0.18)  // ~0.5s crossfade
        func mix(_ x: inout Double, _ target: Double) { x += (target - x) * k }
        mix(&deform, reduceMotion ? 0 : tg.deform)
        mix(&asym, tg.asym)
        mix(&innerSpeed, tg.innerSpeed)
        mix(&rotSpeed, tg.rotSpeed)
        mix(&sat, tg.sat)
        mix(&bright, tg.bright)
        mix(&glow, tg.glow)
        mix(&base, tg.base)
        mix(&levelGain, reduceMotion ? 0 : tg.levelGain)
        mix(&deformGain, reduceMotion ? 0 : tg.deformGain)
        mix(&glowGain, tg.glowGain)
        mix(&spot, reduceMotion ? 0 : tg.spot)

        // Level with inertia: slightly underdamped spring — stretches on peaks,
        // bounces a touch, settles back in silences.
        let target = (state == .listening || state == .speaking) ? raw : 0
        levelVel += (90 * (target - level) - 14 * levelVel) * dt
        level += levelVel * dt
        level = min(max(level, 0), 1.2)

        // Phases accumulate so speed changes never jump position.
        if !reduceMotion {
            innerPhase += innerSpeed * dt
            rotPhase += rotSpeed * dt
        }

        // Ripple on each rising voice peak while listening.
        if state == .listening, !reduceMotion, raw > 0.45, prevRaw <= 0.45, now - lastRipple > 0.3 {
            ripples.append(now)
            lastRipple = now
        }
        prevRaw = raw
        ripples.removeAll { now - $0 > 0.9 }

        // Appear: scale in from 0.6 with a small overshoot (ease-out-back), fade in.
        let ap = min(age / 0.5, 1)
        let appear = 0.6 + 0.4 * (1 + 1.9 * pow(ap - 1, 3) + 0.9 * pow(ap - 1, 2))
        var alpha = min(age / 0.35, 1)
        if reduceMotion { alpha *= 0.88 + 0.12 * (0.5 + 0.5 * sin(now * 2 * .pi / 4)) }
        let breath = 1 + 0.016 * sin(now * 2 * .pi / 4)  // ~4s breathing cycle

        var p = OrbParams()
        p.t = now
        p.scale = appear * base * breath * (1 + levelGain * level)
        p.deform = deform + deformGain * level
        p.asym = asym
        p.innerPhase = innerPhase
        p.rotPhase = rotPhase
        p.sat = sat
        p.bright = bright
        p.glow = (glow + glowGain * level) * (0.85 + 0.15 * sin(now * 2 * .pi / 4))
        p.spot = spot
        p.alpha = alpha
        p.ripples = ripples.map { now - $0 }
        return p
    }
}

#Preview("Voice orb states") {
    let demoPalette: [Color] = [Color(red: 0.35, green: 0.55, blue: 1.0), .purple, .cyan]
    TimelineView(.animation) { tl in
        let t = tl.date.timeIntervalSinceReferenceDate
        let fake = min(1, abs(sin(t * 3.7) * 0.7 + sin(t * 1.3) * 0.4))
        HStack(spacing: 20) {
            ForEach(VoiceOrbState.allCases, id: \.self) { s in
                VStack(spacing: 8) {
                    VoiceOrbView(state: s, level: fake, palette: demoPalette)
                        .frame(width: 96, height: 96)
                    Text(String(describing: s))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(24)
        .background(Color.black)
    }
}
