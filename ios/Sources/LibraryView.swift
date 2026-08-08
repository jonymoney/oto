import SwiftUI

@MainActor
@Observable
final class LibraryModel {
    var items: [AudioItem] = []
    var loading = false
    var errorMessage: String?

    func load(auth: AuthManager) async {
        loading = true
        errorMessage = nil
        do {
            items = try await API.listAudios()
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            // Truly offline (transport error, not 401): fall back to downloads.
            let offline = Downloads.shared.items
            if !offline.isEmpty {
                items = offline
                errorMessage = "Offline — showing downloads"
            } else {
                errorMessage = "Couldn't load your audios."
            }
        }
        loading = false
    }
}

struct LibraryView: View {
    @Environment(AuthManager.self) private var auth
    @State private var model = LibraryModel()
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Group {
                if model.loading && model.items.isEmpty {
                    ProgressView()
                } else if model.items.isEmpty {
                    ContentUnavailableView("No audios yet", systemImage: "waveform",
                        description: Text("Generate audio in your AI chat and it shows up here."))
                } else {
                    List(model.items) { item in
                        NavigationLink(value: item) {
                            HStack(spacing: 12) {
                                CoverThumb(item: item, size: 56)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.title).lineLimit(1).foregroundStyle(Theme.ink)
                                    if let s = item.summary, !s.isEmpty {
                                        Text(s).lineLimit(1).font(.caption).foregroundStyle(Theme.ink2)
                                    }
                                    HStack(spacing: 8) {
                                        Text(item.voice)
                                        if let d = item.durationSec { Text(timecode(d)) }
                                        if item.status != "ready" { Text(item.status).foregroundStyle(Theme.accent) }
                                    }
                                    .font(.caption).foregroundStyle(Theme.ink2)
                                }
                                Spacer(minLength: 8)
                                DownloadAccessory(id: item.id)
                            }
                        }
                        .listRowBackground(Theme.surface)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if Downloads.shared.isDownloaded(item.id) {
                                Button("Remove", role: .destructive) {
                                    Downloads.shared.remove(item.id)
                                }
                            } else {
                                Button("Download") {
                                    Task { await Downloads.shared.download(item) }
                                }
                                .tint(Theme.accent)
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bg)
            .navigationTitle("oto")
            .navigationDestination(for: AudioItem.self) { PlayerView(item: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { confirmingSignOut = true }
                }
            }
            .confirmationDialog("Sign out?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await auth.logout() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll need to sign in again to get back in.")
            }
            .refreshable { await model.load(auth: auth) }
            .task { await model.load(auth: auth) }
            .overlay(alignment: .bottom) {
                if let err = model.errorMessage {
                    Text(err).font(.footnote).foregroundStyle(Theme.danger).padding()
                }
            }
        }
    }
}

/// Trailing download-state accessory: spinner while downloading, filled arrow
/// when downloaded, faint hint otherwise. Reads the observable Downloads store.
struct DownloadAccessory: View {
    let id: String

    var body: some View {
        let downloads = Downloads.shared
        // Touch `items` so the accessory re-renders on download/remove (both mutate it).
        let _ = downloads.items.count
        if downloads.inProgress.contains(id) {
            ProgressView()
        } else if downloads.isDownloaded(id) {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.accent)
        } else {
            Image(systemName: "arrow.down.circle").foregroundStyle(Theme.ink3)
        }
    }
}

/// Rounded cover thumbnail with the emoji badge overlaid in the corner.
struct CoverThumb: View {
    let item: AudioItem
    var size: CGFloat

    var body: some View {
        CoverView(id: item.id, mood: item.mood, size: size)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                if let e = item.emoji, !e.isEmpty {
                    Text(e)
                        .font(.system(size: size * 0.28))
                        .padding(size * 0.08)
                        .background(.thinMaterial, in: Circle())
                        .padding(3)
                }
            }
    }
}

func timecode(_ seconds: Double) -> String {
    let s = Int(seconds.rounded())
    return String(format: "%d:%02d", s / 60, s % 60)
}
