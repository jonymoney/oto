import SwiftUI
import AVFoundation

@MainActor
@Observable
final class SettingsModel {
    var email: String?
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
        // Best-effort: the email is display-only, so a failure just hides it.
        email = try? await API.sessionEmail()
    }

    func save(voice: String? = nil, language: String? = nil) async {
        do {
            prefs = try await API.updatePrefs(voice: voice, language: language)
        } catch {
            errorMessage = "Couldn't save that setting."
        }
    }
}

struct SettingsView: View {
    @Environment(AuthManager.self) private var auth
    @State private var model = SettingsModel()
    @State private var preview = VoicePreviewPlayer()
    @State private var confirmingSignOut = false
    @State private var confirmingRemoveDownloads = false

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Signed in as", value: model.email ?? "—")
            }
            .listRowBackground(Theme.surface)

            Section {
                if let prefs = model.prefs {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(prefs.voices, id: \.self) { voice in
                                VoiceOrbCard(voice: voice, selected: prefs.voice == voice.name, preview: preview) {
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

            Section("Downloads") {
                let downloads = Downloads.shared
                LabeledContent("Downloaded",
                    value: "\(downloads.items.count) · \(ByteCountFormatter.string(fromByteCount: downloads.totalBytes, countStyle: .file))")
                Button("Remove all downloads", role: .destructive) { confirmingRemoveDownloads = true }
                    .disabled(downloads.items.isEmpty)
            }
            .listRowBackground(Theme.surface)

            Section("About") {
                LabeledContent("Version", value: appVersion)
            }
            .listRowBackground(Theme.surface)

            Section {
                Button("Sign out", role: .destructive) { confirmingSignOut = true }
                    .frame(maxWidth: .infinity)
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
