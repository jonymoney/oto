import SwiftUI

@MainActor
@Observable
final class LibraryModel {
    var items: [AudioItem] = []
    var usage: API.Usage?
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
        // Usage is best-effort: a 401 is handled by the list load above; any
        // other failure (offline) just hides the meter — never blocks the library.
        do {
            usage = try await API.usage()
        } catch {
            usage = nil
        }
        loading = false
    }
}

struct LibraryView: View {
    @Environment(AuthManager.self) private var auth
    @State private var model = LibraryModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let usage = model.usage {
                    UsageMeter(usage: usage)
                }
                content
            }
            .background(Theme.bg)
            .navigationTitle("oto")
            .navigationDestination(for: AudioItem.self) { PlayerView(item: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
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

    @ViewBuilder private var content: some View {
        if model.loading && model.items.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
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
}

/// Read-only generation-usage meter shown atop the library. Generation happens
/// in Claude, not here — this only displays the running total against the quota.
struct UsageMeter: View {
    let usage: API.Usage
    @Environment(\.openURL) private var openURL

    private var atLimit: Bool { usage.generatedSec >= usage.quotaSec }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if usage.unlimited {
                Label("Unlimited generation", systemImage: "infinity")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ink2)
            } else {
                HStack {
                    Text("\(minutes(usage.generatedSec)) / \(minutes(usage.quotaSec)) min generated")
                        .font(.subheadline.weight(.medium).monospacedDigit())
                        .foregroundStyle(atLimit ? Theme.danger : Theme.ink)
                    Spacer()
                    Button("Upgrade") {
                        Task {
                            // App users are already signed in — go straight to
                            // Stripe. Fall back to the web page if billing is off.
                            if let url = try? await API.checkout() { openURL(url) }
                            else { openURL(URL(string: "https://oto.audio/upgrade")!) }
                        }
                    }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                }
                GeometryReader { geo in
                    let frac = usage.quotaSec > 0 ? min(usage.generatedSec / usage.quotaSec, 1) : 0
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.line)
                        Capsule().fill(atLimit ? Theme.danger : Theme.accent)
                            .frame(width: geo.size.width * frac)
                    }
                }
                .frame(height: 6)
                if atLimit {
                    Text("Limit reached").font(.caption).foregroundStyle(Theme.danger)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func minutes(_ sec: Double) -> String {
        String(format: "%.1f", sec / 60)
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
