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
        } catch APIError.unauthorized {
            auth.sessionExpired()
            return
        } catch {
            errorMessage = "Couldn't load settings."
        }
        // Best-effort: the email is display-only, so a failure just hides it.
        email = try? await API.sessionEmail()
    }

    func save(voice: String? = nil, provider: String? = nil, language: String? = nil) async {
        do {
            prefs = try await API.updatePrefs(voice: voice, provider: provider, language: language)
        } catch {
            errorMessage = "Couldn't save that setting."
        }
    }
}

struct SettingsView: View {
    @Environment(AuthManager.self) private var auth
    @State private var model = SettingsModel()
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
                    NavigationLink {
                        VoicePickerView(model: model)
                    } label: {
                        LabeledContent(
                            "Default voice",
                            value: prefs.voice?.capitalized ?? "Server default"
                        )
                    }
                    if prefs.providers.count > 1 {
                        Picker("Provider", selection: providerBinding) {
                            if prefs.provider == nil { Text("Server default").tag("") }
                            ForEach(prefs.providers, id: \.self) { Text(providerLabel($0)).tag($0) }
                        }
                    }
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
                Text("Used when your AI chat generates audio without picking a voice.")
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
    private var providerBinding: Binding<String> {
        Binding(
            get: { model.prefs?.provider ?? "" },
            set: { p in
                guard !p.isEmpty, p != model.prefs?.provider else { return }
                Task { await model.save(provider: p) }
            }
        )
    }

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

    private func providerLabel(_ id: String) -> String {
        switch id {
        case "openai": return "OpenAI"
        case "fish": return "Fish Audio"
        default: return id.capitalized
        }
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

struct VoicePickerView: View {
    var model: SettingsModel
    @State private var preview = VoicePreviewPlayer()

    var body: some View {
        List {
            Section {
                ForEach(model.prefs?.voices ?? [], id: \.self) { voice in
                    HStack(spacing: 12) {
                        Button {
                            Task {
                                await preview.toggle(
                                    voice: voice,
                                    provider: model.prefs?.provider,
                                    language: model.prefs?.language
                                )
                            }
                        } label: {
                            if preview.loadingVoice == voice {
                                ProgressView().frame(width: 28)
                            } else {
                                Image(systemName: preview.playingVoice == voice
                                    ? "stop.circle.fill" : "play.circle")
                                    .font(.title2)
                                    .foregroundStyle(Theme.accent)
                                    .frame(width: 28)
                            }
                        }
                        .buttonStyle(.borderless)

                        Button {
                            Task { await model.save(voice: voice) }
                        } label: {
                            HStack {
                                Text(voice.capitalized).foregroundStyle(Theme.ink)
                                Spacer()
                                if model.prefs?.voice == voice {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.accent)
                                }
                            }
                        }
                        .buttonStyle(.borderless)
                    }
                    .listRowBackground(Theme.surface)
                }
            } footer: {
                Text("Tap ▶ to hear each voice introduce itself.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Default voice")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { preview.stop() }
    }
}
