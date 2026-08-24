import SwiftUI

/// Conversion sheet: premium Fish voices as playable orbs + Stripe checkout.
/// Checkout completes in Safari; on return (scenePhase → .active) we re-check
/// usage and celebrate + dismiss when unlimited flipped on.
struct PaywallView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var preview = VoicePreviewPlayer()
    // Static fallback shown immediately; replaced by the server list on load.
    @State private var voices: [API.Voice] = ["sarah", "ethan", "adrian", "jasphina", "blaze", "grim"]
        .map { API.Voice(name: $0, provider: "fish") }
    @State private var language: String?
    @State private var price: String?
    @State private var unlocked = false
    // Purchase rail: US storefront → Stripe web checkout (commission-free);
    // everywhere else → Apple IAP. nil = storefront not resolved yet.
    @State private var usStorefront: Bool?
    @State private var store = StoreIAP()

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if unlocked { success } else { content }
        }
        .task {
            if let p = try? await API.prefs() {
                let fish = p.voices.filter { $0.provider == "fish" }
                if !fish.isEmpty { voices = fish }
                language = p.language
            }
            price = try? await API.usage().price
            usStorefront = await Market.isUS()
            if usStorefront == false { await store.load() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !unlocked else { return }
            Task {
                if let u = try? await API.usage(), u.unlimited { celebrate() }
            }
        }
        .onDisappear { preview.stop() }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 6) {
                    Text("oto unlimited")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(Theme.ink)
                    Text("All voices. Unlimited generation.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink2)
                }
                .padding(.top, 32)

                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(voices, id: \.name) { orbCell($0) }
                }
                .padding(.horizontal, 24)

                Text("Tap a voice to hear it")
                    .font(.caption)
                    .foregroundStyle(Theme.ink3)

                VStack(alignment: .leading, spacing: 12) {
                    bullet("6 premium voices", "sparkles")
                    bullet("Unlimited listening time", "infinity")
                    bullet("Support oto", "heart.fill")
                }
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(spacing: 10) {
                    if usStorefront == false {
                        appleRail
                    } else {
                        stripeRail
                    }
                    // App Review requires both on the paywall screen itself.
                    HStack(spacing: 16) {
                        Link("Terms", destination: URL(string: "https://oto.audio/terms")!)
                        Link("Privacy", destination: URL(string: "https://oto.audio/privacy")!)
                    }
                    .font(.caption2)
                    .foregroundStyle(Theme.ink3)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
    }

    /// US storefront: Stripe web checkout (commission-free under the US
    /// external-purchase rule).
    private var stripeRail: some View {
        VStack(spacing: 10) {
            Button {
                Haptics.impact()
                Task {
                    if let url = try? await API.checkout() { openURL(url) }
                    else { openURL(URL(string: "https://oto.audio/upgrade")!) }
                }
            } label: {
                upgradeLabel("Upgrade")
            }
            Text(price.map { "\($0) — cancel anytime. Purchase completes on the web." }
                ?? "Purchase completes on the web. Cancel anytime.")
                .font(.caption)
                .foregroundStyle(Theme.ink3)
        }
    }

    /// Everywhere else: Apple In-App Purchase.
    @ViewBuilder private var appleRail: some View {
        if let product = store.product {
            Button {
                Haptics.impact()
                Task { if await store.purchase() { celebrate() } }
            } label: {
                upgradeLabel(store.purchasing ? "…" : "Upgrade")
            }
            .disabled(store.purchasing)
            Text("\(product.displayPrice)/month — cancel anytime in Settings.")
                .font(.caption)
                .foregroundStyle(Theme.ink3)
        } else {
            // Product not published (pre-launch) or Store unreachable.
            Text("Purchases aren't available right now.")
                .font(.caption)
                .foregroundStyle(Theme.ink3)
        }
        Button("Restore Purchases") {
            Task { if await store.restore() { celebrate() } }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(Theme.ink2)
    }

    private func upgradeLabel(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(Theme.accent, in: Capsule())
    }

    private func celebrate() {
        preview.stop()
        Haptics.success() // "You're unlimited" appearing
        withAnimation { unlocked = true }
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            dismiss()
        }
    }

    private var success: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Theme.accent)
            Text("You're unlimited ✓")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.ink)
        }
        .transition(.scale.combined(with: .opacity))
    }

    private func bullet(_ text: String, _ icon: String) -> some View {
        Label {
            Text(text).foregroundStyle(Theme.ink)
        } icon: {
            Image(systemName: icon).foregroundStyle(Theme.accent)
        }
        .font(.subheadline.weight(.medium))
    }

    private func orbCell(_ voice: API.Voice) -> some View {
        Button {
            Haptics.tap()
            // Previews are free — same flow as the settings voice cards.
            Task { await preview.toggle(voice: voice.name, provider: voice.provider, language: language) }
        } label: {
            VStack(spacing: 6) {
                orb(for: voice)
                    .frame(width: 76, height: 76)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.ink2)
                            .padding(5)
                            .background(Theme.surface, in: Circle())
                    }
                Text(voice.name.capitalized)
                    .font(.footnote)
                    .foregroundStyle(Theme.ink)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func orb(for voice: API.Voice) -> some View {
        let palette = OrbPalettes.palette(for: voice.name)
        if preview.playingVoice == voice.name {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                // Same fake speech envelope as SettingsView's cards.
                let level = min(1, max(0, 0.55 + 0.25 * sin(t * 24) + 0.2 * sin(t * 4.4 + 1.3)))
                VoiceOrbView(state: .speaking, level: level, palette: palette)
            }
        } else {
            VoiceOrbView(
                state: preview.loadingVoice == voice.name ? .thinking : .idle,
                level: 0,
                palette: palette
            )
        }
    }
}
