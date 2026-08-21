import UIKit

/// App-wide haptic feedback. UIKit generators only (no CoreHaptics needed).
/// All calls are cheap main-thread calls; harmless no-ops on the simulator.
@MainActor
enum Haptics {
    private static let selectionGen = UISelectionFeedbackGenerator()
    private static let lightGen = UIImpactFeedbackGenerator(style: .light)
    private static let mediumGen = UIImpactFeedbackGenerator(style: .medium)
    private static let noteGen = UINotificationFeedbackGenerator()

    /// Warms up the Taptic Engine so the first fire has no latency.
    /// Call once at app start.
    static func prepare() {
        selectionGen.prepare()
        lightGen.prepare()
        mediumGen.prepare()
        noteGen.prepare()
    }

    /// User toggle, persisted. Default on.
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "hapticsEnabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "hapticsEnabled") }
    }

    /// Carousels, pickers, speed cycling.
    static func selection() {
        guard enabled else { return }
        selectionGen.selectionChanged()
        selectionGen.prepare() // keep warm for follow-ups
    }

    /// Buttons, play/pause, copy.
    static func tap() {
        guard enabled else { return }
        lightGen.impactOccurred()
        lightGen.prepare()
    }

    /// Bigger moments: player open, download complete.
    static func impact() {
        guard enabled else { return }
        mediumGen.impactOccurred()
        mediumGen.prepare()
    }

    /// Saves, follow, choose voice, purchase.
    static func success() {
        guard enabled else { return }
        noteGen.notificationOccurred(.success)
        noteGen.prepare()
    }

    /// Destructive confirms, errors.
    static func warning() {
        guard enabled else { return }
        noteGen.notificationOccurred(.warning)
        noteGen.prepare()
    }
}
