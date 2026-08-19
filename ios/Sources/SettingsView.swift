import SwiftUI

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

    func save(voice: String? = nil, provider: String? = nil) async {
        do {
            prefs = try await API.updatePrefs(voice: voice, provider: provider)
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
                    Picker("Default voice", selection: voiceBinding) {
                        // ponytail: "Server default" only shows while unset — once a
                        // voice is picked there's no way back (server has no clear).
                        if prefs.voice == nil { Text("Server default").tag("") }
                        ForEach(prefs.voices, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    if prefs.providers.count > 1 {
                        Picker("Provider", selection: providerBinding) {
                            if prefs.provider == nil { Text("Server default").tag("") }
                            ForEach(prefs.providers, id: \.self) { Text(providerLabel($0)).tag($0) }
                        }
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
    private var voiceBinding: Binding<String> {
        Binding(
            get: { model.prefs?.voice ?? "" },
            set: { v in
                guard !v.isEmpty, v != model.prefs?.voice else { return }
                Task { await model.save(voice: v) }
            }
        )
    }

    private var providerBinding: Binding<String> {
        Binding(
            get: { model.prefs?.provider ?? "" },
            set: { p in
                guard !p.isEmpty, p != model.prefs?.provider else { return }
                Task { await model.save(provider: p) }
            }
        )
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
