import SwiftUI
import AVFoundation

@MainActor
@Observable
final class SettingsModel {
    var email: String?
    var me: API.Me?
    var usage: API.Usage?
    var prefs: API.Prefs?
    var errorMessage: String?

    func load(auth: AuthManager) async {
        do {
            prefs = try await API.prefs()
            // No language pref yet → default to the device's language when supported.
            if let p = prefs, p.language == nil,
               let device = Locale.current.language.languageCode?.identifier,
               p.languages.contains(device) {
                await save(language: device)
            }
        } catch APIError.unauthorized {
            auth.sessionExpired()
            return
        } catch {
            errorMessage = "Couldn't load settings."
        }
        // Best-effort: profile + usage are display-only, failures just hide them.
        me = try? await API.me()
        usage = try? await API.usage()
        if let meEmail = me?.email {
            email = meEmail
        } else {
            email = try? await API.sessionEmail()
        }
    }

    func save(voice: String? = nil, language: String? = nil) async {
        do {
            prefs = try await API.updatePrefs(voice: voice, language: language)
            if voice != nil { Haptics.success() }
        } catch {
            errorMessage = "Couldn't save that setting."
        }
    }
}

struct SettingsView: View {
    @Environment(AuthManager.self) private var auth
    @State private var model = SettingsModel()
    @State private var preview = VoicePreviewPlayer()
    @Environment(\.openURL) private var openURL
    @State private var confirmingSignOut = false
    @State private var confirmingRemoveDownloads = false
    @State private var showingPaywall = false
    @State private var confirmingDelete = false
    @State private var confirmingDeleteFinal = false
    @State private var deleting = false
    @State private var deleteError: String?
    @AppStorage("hapticsEnabled") private var hapticsEnabled = true

    // Fish voices are gated behind unlimited (unless the server hides upgrade UI).
    private var fishLocked: Bool {
        guard let u = model.usage else { return false }
        return !u.unlimited && u.showUpgrade != false
    }

    var body: some View {
        Form {
            Section("Account") {
                HStack(spacing: 12) {
                    AvatarPickerView(
                        avatarUrl: model.me?.avatarUrl,
                        fallbackText: model.me?.username ?? model.email ?? "oto",
                        cacheKey: model.me?.username
                    ) { url in
                        model.me?.avatarUrl = url
                    }
                    Text(model.email ?? "—")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink)
                }
                NavigationLink {
                    UsernameEditView(current: model.me?.username) { model.me = $0 }
                } label: {
                    LabeledContent("Username", value: model.me?.username.map { "@\($0)" } ?? "Set username")
                }
            }
            .listRowBackground(Theme.surface)

            Section {
                if let prefs = model.prefs {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(prefs.voices, id: \.self) { voice in
                                let locked = fishLocked && voice.provider == "fish"
                                VoiceOrbCard(voice: voice, selected: prefs.voice == voice.name, locked: locked, preview: preview) {
                                    // ponytail: one tap gesture per orb — a locked orb opens
                                    // the paywall (which has its own previews) instead of playing.
                                    if locked {
                                        showingPaywall = true
                                        return
                                    }
                                    if prefs.voice != voice.name {
                                        Haptics.selection()
                                    } else {
                                        Haptics.tap() // pure preview toggle on the selected orb
                                    }
                                    Task {
                                        if prefs.voice != voice.name { await model.save(voice: voice.name) }
                                        await preview.toggle(
                                            voice: voice.name,
                                            provider: voice.provider,
                                            language: prefs.language
                                        )
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }
                    .listRowInsets(EdgeInsets())
                    Picker("Language", selection: languageBinding) {
                        if prefs.language == nil { Text("Server default").tag("") }
                        ForEach(prefs.languages, id: \.self) { Text(languageLabel($0)).tag($0) }
                    }
                } else if model.errorMessage != nil {
                    Button {
                        model.errorMessage = nil
                        Task { await model.load(auth: auth) }
                    } label: {
                        Label("Couldn't load — tap to retry", systemImage: "arrow.clockwise")
                            .foregroundStyle(Theme.ink2)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: {
                Text("Generation")
            } footer: {
                Text("Tap a voice to hear it introduce itself. Used when your AI chat generates audio without picking a voice.")
            }
            .listRowBackground(Theme.surface)

            if let usage = model.usage, usage.unlimited || usage.showUpgrade == true {
                Section {
                    if usage.unlimited {
                        Button("Manage subscription") { Task { await openBillingPortal() } }
                            .foregroundStyle(Theme.ink)
                    } else {
                        Button {
                            showingPaywall = true
                        } label: {
                            Label("Unlock all voices + unlimited generation", systemImage: "sparkles")
                                .foregroundStyle(Theme.accent)
                        }
                    }
                } header: {
                    Text("oto unlimited")
                } footer: {
                    if usage.unlimited {
                        Text("Purchased on the web — restore by signing in with the same email.")
                    }
                }
                .listRowBackground(Theme.surface)
            }

            Section("Downloads") {
                let downloads = Downloads.shared
                LabeledContent("Downloaded",
                    value: "\(downloads.items.count) · \(ByteCountFormatter.string(fromByteCount: downloads.totalBytes, countStyle: .file))")
                Button("Remove all downloads", role: .destructive) { confirmingRemoveDownloads = true }
                    .disabled(downloads.items.isEmpty)
            }
            .listRowBackground(Theme.surface)

            Section("Connect") {
                NavigationLink("How to connect your AI") { ConnectGuideView() }
            }
            .listRowBackground(Theme.surface)

            Section("App") {
                Toggle("Haptics", isOn: $hapticsEnabled)
            }
            .listRowBackground(Theme.surface)

            Section("About") {
                LabeledContent("Version", value: appVersion)
                Link("Terms", destination: URL(string: "https://oto.audio/terms")!)
                    .foregroundStyle(Theme.ink)
                Link("Privacy", destination: URL(string: "https://oto.audio/privacy")!)
                    .foregroundStyle(Theme.ink)
            }
            .listRowBackground(Theme.surface)

            Section {
                Button("Sign out", role: .destructive) { confirmingSignOut = true }
                    .frame(maxWidth: .infinity)
            }
            .listRowBackground(Theme.surface)

            Section {
                Button(role: .destructive) {
                    Haptics.warning()
                    confirmingDelete = true
                } label: {
                    if deleting {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("Delete account").frame(maxWidth: .infinity)
                    }
                }
                .disabled(deleting)
            }
            .listRowBackground(Theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(auth: auth) }
        .onDisappear { preview.stop() }
        .confirmationDialog("Sign out?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await auth.logout() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need to sign in again to get back in.")
        }
        .confirmationDialog("Remove all downloads?", isPresented: $confirmingRemoveDownloads, titleVisibility: .visible) {
            Button("Remove all", role: .destructive) { Downloads.shared.removeAll() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Audios stay in your library and can be downloaded again.")
        }
        .sheet(isPresented: $showingPaywall) { PaywallView() }
        .confirmationDialog("Delete account?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Continue", role: .destructive) { confirmingDeleteFinal = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Deletes your account, all audios and files. This cannot be undone.")
        }
        .alert("Are you sure?", isPresented: $confirmingDeleteFinal) {
            Button("Delete everything", role: .destructive) { Task { await deleteAccount() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This is permanent.")
        }
        .alert("Couldn't delete your account", isPresented: Binding(
            get: { deleteError != nil },
            set: { if !$0 { deleteError = nil } }
        )) {
            Button("OK") {}
        } message: {
            Text(deleteError ?? "")
        }
        .overlay(alignment: .bottom) {
            if let err = model.errorMessage {
                Text(err).font(.footnote).foregroundStyle(Theme.danger).padding()
            }
        }
    }

    // Empty tag "" = server default (shown only while unset); picking an option saves it.
    private var languageBinding: Binding<String> {
        Binding(
            get: { model.prefs?.language ?? "" },
            set: { l in
                guard !l.isEmpty, l != model.prefs?.language else { return }
                Haptics.selection()
                Task { await model.save(language: l) }
            }
        )
    }

    private func languageLabel(_ code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code)?.capitalized ?? code
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }

    private func openBillingPortal() async {
        do {
            openURL(try await API.billingPortal())
        } catch {
            model.errorMessage = "Couldn't open the billing portal."
        }
    }

    /// Server deletes the account and revokes the session; locally we only need
    /// the same teardown as an expired session (wipe + token clear + back to login).
    private func deleteAccount() async {
        deleting = true
        defer { deleting = false }
        do {
            try await API.deleteAccount()
            auth.sessionExpired()
        } catch {
            if case let APIError.server(m) = error {
                deleteError = m
            } else {
                deleteError = "Check your connection and try again."
            }
        }
    }
}

// MARK: - Connect guide

private struct ConnectGuideView: View {
    @State private var copied: String?

    private static let mcpURL = "https://oto.audio/mcp"
    private static let claudeCodeCmd = "claude mcp add --transport http oto https://oto.audio/mcp"

    var body: some View {
        Form {
            Section {
                copyRow(Self.mcpURL)
            } header: {
                Text("MCP server")
            } footer: {
                Text("One URL — any MCP-capable AI can connect to it. Tap to copy.")
            }
            .listRowBackground(Theme.surface)

            Section("Claude") {
                step(1, "Open claude.ai → Settings → Connectors")
                step(2, "Add a custom connector with the URL above")
                step(3, "Ask Claude to read anything aloud")
            }
            .listRowBackground(Theme.surface)

            Section("Claude Code") {
                copyRow(Self.claudeCodeCmd)
                    .font(.system(.footnote, design: .monospaced))
            }
            .listRowBackground(Theme.surface)

            Section {
                Link("Full guide", destination: URL(string: "https://oto.audio/connect")!)
                    .foregroundStyle(Theme.accent)
            }
            .listRowBackground(Theme.surface)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Connect your AI")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func copyRow(_ text: String) -> some View {
        Button {
            Haptics.tap()
            UIPasteboard.general.string = text
            copied = text
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                if copied == text { copied = nil }
            }
        } label: {
            HStack {
                Text(text)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if copied == text {
                    Text("Copied").font(.caption).foregroundStyle(Theme.accent)
                } else {
                    Image(systemName: "doc.on.doc").foregroundStyle(Theme.ink2)
                }
            }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.caption.weight(.bold)).foregroundStyle(Theme.accent)
            Text(text).foregroundStyle(Theme.ink)
        }
    }
}

// MARK: - Voice picker with previews

/// One-at-a-time preview playback. Each voice's sample is generated server-side
/// on first request and cached in the bucket, so replays are instant.
@MainActor
@Observable
final class VoicePreviewPlayer {
    private var player: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private(set) var playingVoice: String?
    private(set) var loadingVoice: String?

    func toggle(voice: String, provider: String?, language: String?) async {
        if playingVoice == voice || loadingVoice == voice {
            stop()
            return
        }
        stop()
        loadingVoice = voice
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        do {
            let url = try await API.voicePreviewURL(voice: voice, provider: provider, language: language)
            guard loadingVoice == voice else { return } // user tapped elsewhere meanwhile
            let p = AVPlayer(url: url)
            endObserver = NotificationCenter.default.addObserver(
                forName: AVPlayerItem.didPlayToEndTimeNotification,
                object: p.currentItem, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.stop() }
            }
            player = p
            playingVoice = voice
            p.play()
        } catch {
            // Best-effort: leave the row idle on failure.
        }
        loadingVoice = nil
    }

    func stop() {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player?.pause()
        player = nil
        playingVoice = nil
        loadingVoice = nil
    }
}

// Square card: orb + name + provider. Tapping selects the voice and plays its
// intro; the orb goes thinking while loading and speaking while the sample plays.
private struct VoiceOrbCard: View {
    let voice: API.Voice
    let selected: Bool
    var locked: Bool = false
    let preview: VoicePreviewPlayer
    let tap: () -> Void

    private var providerLabel: String {
        switch voice.provider {
        case "openai": return "OpenAI"
        case "fish": return "Fish Audio"
        default: return voice.provider.capitalized
        }
    }

    var body: some View {
        Button(action: tap) {
            VStack(spacing: 4) {
                orb.frame(width: 76, height: 76)
                Text(voice.name.capitalized)
                    .font(.footnote.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Theme.accent : Theme.ink)
                Text(providerLabel)
                    .font(.caption2)
                    .foregroundStyle(Theme.ink2)
            }
            .frame(width: 104, height: 128)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(selected ? Theme.accent : .clear, lineWidth: 1.5)
            )
            .overlay(alignment: .topTrailing) {
                if locked {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.ink2)
                        .padding(5)
                        .background(Theme.surface, in: Circle())
                        .padding(6)
                }
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var orb: some View {
        let palette = OrbPalettes.palette(for: voice.name)
        if preview.playingVoice == voice.name {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                // ponytail: fake speech envelope (syllable + phrase sines); swap in
                // real audio metering (MTAudioProcessingTap) if fidelity ever matters.
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
