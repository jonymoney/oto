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
            errorMessage = "Couldn't load your audios."
        }
        loading = false
    }
}

struct LibraryView: View {
    @Environment(AuthManager.self) private var auth
    @State private var model = LibraryModel()

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
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title).lineLimit(1)
                                HStack(spacing: 8) {
                                    Text(item.voice)
                                    if let d = item.durationSec { Text(timecode(d)) }
                                    if item.status != "ready" { Text(item.status).foregroundStyle(.orange) }
                                }
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("oto")
            .navigationDestination(for: AudioItem.self) { PlayerView(item: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { Task { await auth.signOut() } }
                }
            }
            .refreshable { await model.load(auth: auth) }
            .task { await model.load(auth: auth) }
            .overlay(alignment: .bottom) {
                if let err = model.errorMessage {
                    Text(err).font(.footnote).foregroundStyle(.red).padding()
                }
            }
        }
    }
}

func timecode(_ seconds: Double) -> String {
    let s = Int(seconds.rounded())
    return String(format: "%d:%02d", s / 60, s % 60)
}
