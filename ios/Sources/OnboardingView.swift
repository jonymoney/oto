import SwiftUI
import UIKit

/// First-run gate. The orchestrator wires `if Onboarding.needed { OnboardingView(done:) }`.
/// Tracked PER ACCOUNT (email) in local settings: the completed set survives
/// sign-out, so a returning account skips onboarding while a brand-new
/// account on the same device still gets it.
enum Onboarding {
    private static let doneKey = "onboardedEmails"     // accounts that finished it
    private static let accountKey = "onboardingAccount" // currently signed-in email

    /// Called on successful sign-in with the account's email. Lowercased so
    /// "Foo@x.com" and "foo@x.com" count as the same account across logins.
    static func signedIn(email: String) {
        UserDefaults.standard.set(email.lowercased(), forKey: accountKey)
    }

    /// Sign-out wipe: forget who is signed in, but keep the completed set.
    static func signedOut() {
        UserDefaults.standard.removeObject(forKey: accountKey)
    }

    static var needed: Bool {
        // No recorded account (session predates this key): don't re-onboard.
        guard let email = UserDefaults.standard.string(forKey: accountKey) else { return false }
        return !(UserDefaults.standard.stringArray(forKey: doneKey) ?? []).contains(email)
    }

    static func markDone() {
        guard let email = UserDefaults.standard.string(forKey: accountKey) else { return }
        var done = UserDefaults.standard.stringArray(forKey: doneKey) ?? []
        guard !done.contains(email) else { return }
        done.append(email)
        UserDefaults.standard.set(done, forKey: doneKey)
    }

    #if DEBUG
    /// Settings debug menu: forget completion for the signed-in account so
    /// onboarding relaunches on next app start. Never compiled into Release.
    static func debugReset() {
        guard let email = UserDefaults.standard.string(forKey: accountKey) else { return }
        var done = UserDefaults.standard.stringArray(forKey: doneKey) ?? []
        done.removeAll { $0 == email }
        UserDefaults.standard.set(done, forKey: doneKey)
    }
    #endif
}

/// Four-page first-run flow: what oto is, pick a voice, pick a cover style,
/// connect your AI.
struct OnboardingView: View {
    let done: () -> Void
    init(done: @escaping () -> Void) { self.done = done }

    @State private var page = 0
    @State private var coverStyle = "classic"
    @State private var prefs: API.Prefs?
    @State private var usage: API.Usage?
    @State private var showingPaywall = false
    @State private var prefsFailed = false
    @State private var centeredVoice: API.Voice?
    @State private var preview = VoicePreviewPlayer()
    @State private var autoplayTask: Task<Void, Never>?
    @State private var copied: String?

    private let mcpURL = "https://oto.audio/mcp"

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $page) {
                welcomePage.tag(0)
                voicePage.tag(1)
                stylePage.tag(2)
                connectPage.tag(3)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            pageDots
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .overlay(alignment: .topTrailing) {
            if page < 3 {
                Button("Skip") { finish() }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ink2)
                    .padding(20)
            }
        }
        .tint(Theme.accent)
        .task { await loadPrefs() }
        // PaywallView dismisses itself once the purchase lands; re-reading
        // usage here drops the locks so the new subscriber can pick the voice.
        .sheet(isPresented: $showingPaywall, onDismiss: {
            Task { usage = try? await API.usage() }
        }) { PaywallView() }
        .onChange(of: centeredVoice) { old, voice in
            if old != nil { Haptics.selection() }
            autoplayTask?.cancel()
            guard let voice, page == 1 else { return }
            // Debounce so we only play once the carousel settles.
            autoplayTask = Task {
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else { return }
                await play(voice)
            }
        }
        .onChange(of: page) { _, p in
            if p != 0 {
                autoplayTask?.cancel()
                preview.stop()
            }
        }
    }

    private func finish() {
        autoplayTask?.cancel()
        preview.stop()
        Onboarding.markDone()
        done()
    }

    private func loadPrefs() async {
        guard prefs == nil else { return }
        usage = try? await API.usage() // before prefs — shownVoices depends on it
        do {
            let p = try await API.prefs()
            prefs = p
            let shown = shownVoices(p.voices)
            centeredVoice = shown.first { $0.name == p.voice } ?? shown.first
        } catch {
            prefsFailed = true
        }
    }

    // Same gate as SettingsView: fish voices are locked whenever a quota is
    // active. Fail closed while usage is loading.
    private var fishLocked: Bool {
        guard let u = usage else { return true }
        return !u.unlimited && u.quotaSec > 0
    }
    private var canUpgrade: Bool { usage?.showUpgrade == true }
    private func isLocked(_ voice: API.Voice) -> Bool {
        voice.provider == "fish" && fishLocked
    }

    /// The pitch lineup: 2 OpenAI voices, then every fish voice. Falls back to
    /// all OpenAI voices when fish isn't available — or isn't purchasable here
    /// (upgrade UI hidden), where locked voices would be a dead end.
    private func shownVoices(_ all: [API.Voice]) -> [API.Voice] {
        let openai = all.filter { $0.provider == "openai" }
        let fish = all.filter { $0.provider == "fish" }
        if fish.isEmpty || (fishLocked && !canUpgrade) { return openai }
        return Array(openai.prefix(2)) + fish
    }

    private func play(_ voice: API.Voice) async {
        await preview.toggle(voice: voice.name, provider: voice.provider, language: prefs?.language)
    }

    // MARK: - Page 0: what is oto

    private var welcomePage: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)

            VoiceOrbView(state: .idle, level: 0, palette: OrbPalettes.palette(for: "alloy"))
                .frame(width: 200, height: 200)
                .padding(.bottom, 28)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 12, height: 12)
                Text("oto")
                    .font(.system(size: 46, weight: .bold))
                    .tracking(-1.5)
                    .foregroundStyle(Theme.ink)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("oto")

            Text("Anything, read aloud.")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .padding(.top, 6)

            Text("Ask your AI chat to read articles, notes, or stories — oto turns them into audios that live here, ready to play anytime.")
                .font(.subheadline)
                .foregroundStyle(Theme.ink2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
                .padding(.top, 10)

            Spacer(minLength: 0)

            Button {
                Haptics.tap()
                withAnimation(.spring(duration: 0.35)) { page = 1 }
            } label: {
                Text("Get started")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }

    // MARK: - Page 1: pick your voice

    private var voicePage: some View {
        VStack(spacing: 0) {
            Text("Pick your voice")
                .font(.largeTitle.bold())
                .foregroundStyle(Theme.ink)
                .padding(.top, 72)

            Spacer(minLength: 0)

            if let prefs {
                voiceCarousel(shownVoices(prefs.voices))
            } else if prefsFailed {
                VStack(spacing: 16) {
                    VoiceOrbView(state: .idle, level: 0, palette: OrbPalettes.palette(for: "alloy"))
                        .frame(width: 220, height: 220)
                    Text("You can pick a voice later in Settings.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink2)
                }
            } else {
                ProgressView()
            }

            Spacer(minLength: 0)

            Button {
                // Centered on a locked voice: the CTA is the subscribe modal,
                // not a selection — the voice stays locked until unlimited.
                if let voice = centeredVoice, isLocked(voice) {
                    Haptics.impact()
                    showingPaywall = true
                    return
                }
                Haptics.success()
                let voice = centeredVoice
                autoplayTask?.cancel()
                preview.stop()
                if let voice {
                    // ponytail: best-effort persist; Settings is the recovery path if it fails
                    Task { _ = try? await API.updatePrefs(voice: voice.name) }
                }
                withAnimation(.spring(duration: 0.35)) { page = 2 }
            } label: {
                Text(chooseLabel)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(prefs == nil && !prefsFailed)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }

    private func voiceCarousel(_ voices: [API.Voice]) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(voices, id: \.self) { voice in
                    voiceSlide(voice)
                        .containerRelativeFrame(.horizontal)
                        .id(voice)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $centeredVoice)
        .scrollIndicators(.hidden)
    }

    // Same label locked or not — a locked choose just opens the paywall.
    private var chooseLabel: String {
        centeredVoice.map { String(localized: "Choose \($0.name.capitalized)") } ?? String(localized: "Continue")
    }

    private func voiceSlide(_ voice: API.Voice) -> some View {
        VStack(spacing: 16) {
            Button {
                // Locked orb → subscribe modal (previews still autoplay on
                // centering, so the voice has already introduced itself).
                if isLocked(voice) {
                    Haptics.impact()
                    showingPaywall = true
                    return
                }
                Haptics.tap()
                Task { await play(voice) }
            } label: {
                slideOrb(voice)
                    .frame(width: 220, height: 220)
                    .overlay(alignment: .topTrailing) {
                        if isLocked(voice) {
                            Image(systemName: "lock.fill")
                                .font(.subheadline)
                                .foregroundStyle(Theme.ink2)
                                .padding(8)
                                .background(Theme.surface, in: Circle())
                                .padding(10)
                        }
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                isLocked(voice)
                    ? String(localized: "\(voice.name.capitalized) — unlock with oto unlimited")
                    : String(localized: "Play \(voice.name.capitalized) preview")
            )

            VStack(spacing: 2) {
                Text(voice.name.capitalized)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                Text(providerLabel(voice.provider))
                    .font(.caption)
                    .foregroundStyle(Theme.ink2)
            }
        }
    }

    @ViewBuilder private func slideOrb(_ voice: API.Voice) -> some View {
        let palette = OrbPalettes.palette(for: voice.name)
        if preview.playingVoice == voice.name {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                // ponytail: fake speech envelope, same as SettingsView's cards
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

    private func providerLabel(_ provider: String) -> String {
        switch provider {
        case "openai": return "OpenAI"
        case "fish": return "Fish Audio"
        default: return provider.capitalized
        }
    }

    // MARK: - Page 2: pick a cover style

    private var stylePage: some View {
        VStack(spacing: 0) {
            Text("Pick a cover style")
                .font(.largeTitle.bold())
                .foregroundStyle(Theme.ink)
                .padding(.top, 72)

            Spacer(minLength: 0)

            VStack(spacing: 20) {
                CoverStylePicker(selection: $coverStyle)
                Text("Every audio you make gets generated cover art in this style. Change it anytime in Settings.")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }

            Spacer(minLength: 0)

            Button {
                Haptics.success()
                // ponytail: best-effort persist; Settings is the recovery path if it fails
                Task { _ = try? await API.updateCoverStyle(coverStyle) }
                withAnimation(.spring(duration: 0.35)) { page = 3 }
            } label: {
                Text("Continue")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }

    // MARK: - Page 3: connect your AI

    private var connectPage: some View {
        VStack(spacing: 0) {
            Text("Connect your AI")
                .font(.largeTitle.bold())
                .foregroundStyle(Theme.ink)
                .padding(.top, 72)

            Spacer(minLength: 16)

            VStack(spacing: 16) {
                copyChip(mcpURL)

                instructionCard("bubble.left.and.bubble.right", "Claude") {
                    Text("Settings → Connectors → Add custom connector → paste the URL")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink2)
                }

                instructionCard("sparkles", "ChatGPT") {
                    Text("Settings → Connectors → enable Developer mode → Create → paste the URL")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink2)
                }

                Link("Full guide", destination: URL(string: "https://oto.audio/connect")!)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 24)

            Spacer(minLength: 16)

            Button {
                Haptics.tap()
                finish()
            } label: {
                Text("Start listening")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }

    private func copyChip(_ text: String) -> some View {
        Button {
            copy(text)
        } label: {
            HStack(spacing: 10) {
                Text(text)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if copied == text {
                    Label("Copied", systemImage: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                } else {
                    Image(systemName: "doc.on.doc")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink3)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy MCP URL")
    }

    private func instructionCard(_ symbol: String, _ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    }

    private func copy(_ text: String) {
        Haptics.tap()
        UIPasteboard.general.string = text
        withAnimation(.spring(duration: 0.25)) { copied = text }
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if copied == text {
                withAnimation(.spring(duration: 0.25)) { copied = nil }
            }
        }
    }

    // MARK: - Page indicator

    private var pageDots: some View {
        HStack(spacing: 8) {
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(i == page ? Theme.accent : Theme.ink3.opacity(0.4))
                    .frame(width: i == page ? 20 : 7, height: 7)
                    .animation(.spring(duration: 0.3), value: page)
            }
        }
        .padding(.top, 8)
    }
}

#Preview {
    OnboardingView(done: {})
}
