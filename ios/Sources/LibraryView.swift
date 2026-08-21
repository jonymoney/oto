import SwiftUI

@MainActor
@Observable
final class LibraryModel {
    var items: [AudioItem] = []
    var usage: API.Usage?
    var collections: [API.Collection] = []
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
        // Collections feed the "Add to Collection" context menu — best-effort,
        // keep the stale list on failure.
        if let c = try? await API.collections() { collections = c }
        loading = false
    }
}

struct LibraryView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(PlayerModel.self) private var player
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = LibraryModel()
    @State private var newCollectionFor: AudioItem?
    @State private var newCollectionName = ""
    @State private var pendingRemoveDownload: AudioItem?

    /// Poll while something is still generating and the app is frontmost.
    private var isPolling: Bool {
        scenePhase == .active && model.items.contains { $0.status == "processing" }
    }

    // Unlimited reads as an exponent on the wordmark — oto∞, like n².
    // navigationTitle strips rich-text styling, so the styled mark lives in the
    // nav bar as a leading toolbar item (the Apple Music/News branded-header
    // pattern), sized down to fit the inline bar without clipping.
    private var unlimited: Bool { model.usage?.unlimited == true }

    private var wordmark: some View {
        (Text("oto").font(.system(size: 26, weight: .bold))
            + Text(unlimited ? "∞" : "")
                .font(.system(size: 16, weight: .bold))
                .baselineOffset(10)
                .foregroundStyle(Theme.accent))
            .accessibilityLabel(unlimited ? "oto — unlimited generation" : "oto")
            .accessibilityAddTraits(.isHeader)
    }

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bg)
                .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    wordmark
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        CollectionsView()
                    } label: {
                        Image(systemName: "folder")
                    }
                    .accessibilityLabel("Collections")
                }
            }
            .refreshable { await model.load(auth: auth) }
            .task { await model.load(auth: auth) }
            .task(id: isPolling) {
                guard isPolling else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled else { return }
                    await model.load(auth: auth)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.load(auth: auth) } }
            }
            // Full-player sheet dismissed (requestedItem → nil): reload so a
            // delete inside the player drops out of the list immediately, and
            // playback positions ("Continue Listening") stay fresh.
            .onChange(of: player.requestedItem?.id) { _, id in
                if id == nil { Task { await model.load(auth: auth) } }
            }
            .overlay(alignment: .bottom) {
                if let err = model.errorMessage, !model.items.isEmpty {
                    Text(err).font(.footnote).foregroundStyle(Theme.danger).padding()
                }
            }
            .alert("New collection", isPresented: Binding(
                get: { newCollectionFor != nil },
                set: { if !$0 { newCollectionFor = nil } }
            )) {
                TextField("Name", text: $newCollectionName)
                Button("Create") {
                    let item = newCollectionFor
                    let name = newCollectionName.trimmingCharacters(in: .whitespacesAndNewlines)
                    newCollectionFor = nil
                    newCollectionName = ""
                    guard let item, (1...60).contains(name.count) else { return }
                    Task {
                        if let c = try? await API.createCollection(name: name) {
                            if (try? await API.addToCollection(id: c.id, audioId: item.id)) != nil { Haptics.success() }
                            await model.load(auth: auth)
                        }
                    }
                }
                Button("Cancel", role: .cancel) { newCollectionName = "" }
            }
            // Shared confirm for the context-menu and swipe remove-download
            // actions (DownloadAccessory carries its own).
            .confirmationDialog(
                "Remove download?",
                isPresented: Binding(
                    get: { pendingRemoveDownload != nil },
                    set: { if !$0 { pendingRemoveDownload = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove download", role: .destructive) {
                    guard let item = pendingRemoveDownload else { return }
                    pendingRemoveDownload = nil
                    Haptics.warning()
                    Downloads.shared.remove(item.id)
                }
                Button("Cancel", role: .cancel) { pendingRemoveDownload = nil }
            } message: {
                Text("The audio stays in your library and can be downloaded again.")
            }
        }
    }

    @ViewBuilder private var content: some View {
        if model.loading && model.items.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.items.isEmpty {
            // ScrollView host so pull-to-refresh works in empty/error states too.
            ScrollView {
                if let usage = model.usage, !usage.unlimited {
                    UsageMeter(usage: usage)
                }
                Group {
                    if model.errorMessage != nil {
                        ContentUnavailableView {
                            Label("Couldn't load", systemImage: "wifi.slash")
                        } description: {
                            Text("Check your connection and try again.")
                        } actions: {
                            Button("Retry") { Task { await model.load(auth: auth) } }
                                .buttonStyle(.borderedProminent)
                        }
                    } else {
                        ContentUnavailableView("No audios yet", systemImage: "waveform",
                            description: Text("Generate audio in your AI chat and it shows up here."))
                    }
                }
                .containerRelativeFrame(.vertical)
            }
        } else {
            List {
                if let usage = model.usage, !usage.unlimited {
                    Section {
                        UsageMeter(usage: usage)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                }
                if !continueItems.isEmpty {
                    Section {
                        ForEach(continueItems) { row(for: $0, inProgress: true) }
                    } header: {
                        Text("Continue Listening").foregroundStyle(Theme.ink2)
                    }
                }
                Section {
                    ForEach(restItems) { row(for: $0, inProgress: false) }
                }
            }
            .scrollContentBackground(.hidden)
        }
    }

    /// Items with a meaningful saved position (>5s, <95% done), freshest first.
    /// The local ResumeStore mirror wins over the server value (offline plays).
    private var continueItems: [AudioItem] {
        model.items.filter { item in
            guard item.status == "ready", let d = item.durationSec, d > 0 else { return false }
            let pos = ResumeStore.get(item.id) ?? item.positionSec ?? 0
            return pos > 5 && pos < d * 0.95
        }
        .sorted { ($0.playedAt ?? "") > ($1.playedAt ?? "") }
    }

    /// Everything not in progress, in the API's createdAt-desc order.
    private var restItems: [AudioItem] {
        let inProgress = Set(continueItems.map(\.id))
        return model.items.filter { !inProgress.contains($0.id) }
    }

    private func row(for item: AudioItem, inProgress: Bool) -> some View {
        Button {
            Haptics.tap()
            player.requestedItem = item
        } label: {
            HStack(spacing: 12) {
                CoverThumb(item: item, size: 56)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(item.title).lineLimit(1).foregroundStyle(Theme.ink)
                        // NEW only makes sense for own audios — saved items carry
                        // the owner's playedAt semantics.
                        if !inProgress, item.owner == nil, item.playedAt == nil, item.status == "ready" {
                            Text("NEW")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                    if let owner = item.owner {
                        Text("@\(owner)").font(.caption2).foregroundStyle(Theme.ink2)
                    }
                    if let s = item.summary, !s.isEmpty {
                        Text(s).lineLimit(1).font(.caption).foregroundStyle(Theme.ink2)
                    }
                    HStack(spacing: 8) {
                        Text(item.voice)
                        if let d = item.durationSec { Text(timecode(d)) }
                        if item.status == "processing" {
                            ProgressView().controlSize(.mini)
                            Text("Generating…").foregroundStyle(Theme.accent)
                        } else if item.status != "ready" {
                            Text(item.status).foregroundStyle(Theme.danger)
                        }
                    }
                    .font(.caption).foregroundStyle(Theme.ink2)
                    if inProgress, let d = item.durationSec, d > 0 {
                        let pos = ResumeStore.get(item.id) ?? item.positionSec ?? 0
                        HStack(spacing: 8) {
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Theme.line)
                                    Capsule().fill(Theme.accent)
                                        .frame(width: geo.size.width * min(max(pos / d, 0), 1))
                                }
                            }
                            .frame(height: 3)
                            Text("\(timecode(max(d - pos, 0))) left")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(Theme.ink2)
                        }
                    }
                }
                Spacer(minLength: 8)
                if item.status == "ready" { DownloadAccessory(item: item) }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.ink3)
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(Theme.surface)
        .contextMenu {
            if item.owner == nil, item.status == "ready" {
                visibilityMenu(for: item)
                addToCollectionMenu(for: item)
            }
            if Downloads.shared.isDownloaded(item.id) {
                Button("Remove download", systemImage: "trash", role: .destructive) {
                    pendingRemoveDownload = item
                }
            } else if item.status == "ready", !Downloads.shared.inProgress.contains(item.id) {
                Button("Download", systemImage: "arrow.down.circle") {
                    Task { await Downloads.shared.download(item); if Downloads.shared.isDownloaded(item.id) { Haptics.success() } }
                }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if item.owner != nil {
                // Saved from someone else — un-save, don't delete.
                Button("Remove", systemImage: "bookmark.slash") {
                    Task {
                        try? await API.removeSavedAudio(id: item.id)
                        await model.load(auth: auth)
                    }
                }
                .tint(Theme.ink3)
            } else if Downloads.shared.isDownloaded(item.id) {
                Button("Remove", role: .destructive) {
                    pendingRemoveDownload = item
                }
            } else if item.status == "ready" {
                Button("Download") {
                    Task { await Downloads.shared.download(item); if Downloads.shared.isDownloaded(item.id) { Haptics.success() } }
                }
                .tint(Theme.accent)
            }
        }
    }

    @ViewBuilder private func visibilityMenu(for item: AudioItem) -> some View {
        let current = item.visibility ?? "private"
        Menu("Visibility") {
            ForEach(["private", "followers", "friends", "public"], id: \.self) { v in
                Button {
                    guard v != current else { return }
                    Task {
                        if (try? await API.setVisibility(audioId: item.id, v)) != nil { Haptics.success() }
                        await model.load(auth: auth)
                    }
                } label: {
                    if v == current {
                        Label(v.capitalized, systemImage: "checkmark")
                    } else {
                        Text(v.capitalized)
                    }
                }
            }
        }
    }

    @ViewBuilder private func addToCollectionMenu(for item: AudioItem) -> some View {
        Menu("Add to Collection") {
            ForEach(model.collections) { c in
                Button(c.name) {
                    Task {
                        if (try? await API.addToCollection(id: c.id, audioId: item.id)) != nil { Haptics.success() }
                        await model.load(auth: auth)
                    }
                }
            }
            if !model.collections.isEmpty { Divider() }
            Button("New collection…") { newCollectionFor = item }
        }
    }
}

/// Read-only generation-usage meter shown atop the library for QUOTA users.
/// Generation happens in Claude, not here — this only displays the running
/// total against the quota. Unlimited users get the toolbar ∞ mark instead.
struct UsageMeter: View {
    let usage: API.Usage
    @Environment(\.openURL) private var openURL
    @State private var showPaywall = false

    private var atLimit: Bool { usage.generatedSec >= usage.quotaSec }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(minutes(usage.generatedSec)) / \(minutes(usage.quotaSec)) min generated")
                    .font(.subheadline.weight(.medium).monospacedDigit())
                    .foregroundStyle(atLimit ? Theme.danger : Theme.ink)
                Spacer()
                Button("Upgrade") {
                    if usage.showUpgrade == true {
                        showPaywall = true
                    } else {
                        Task {
                            // App users are already signed in — go straight to
                            // Stripe. Fall back to the web page if billing is off.
                            if let url = try? await API.checkout() { openURL(url) }
                            else { openURL(URL(string: "https://oto.audio/upgrade")!) }
                        }
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        .sheet(isPresented: $showPaywall) { PaywallView() }
    }

    private func minutes(_ sec: Double) -> String {
        String(format: "%.1f", sec / 60)
    }
}

/// Trailing download-state button: spinner while downloading, filled arrow
/// when downloaded (tap asks to remove), faint hint otherwise (tap downloads).
/// Borderless so the tap doesn't hijack the row's NavigationLink.
/// ponytail: no percent progress — plain spinner; add a URLSession delegate if
/// files ever get big enough to care.
struct DownloadAccessory: View {
    let item: AudioItem
    @State private var confirmingRemove = false

    var body: some View {
        let downloads = Downloads.shared
        // Touch `items` so the accessory re-renders on download/remove (both mutate it).
        let _ = downloads.items.count
        if downloads.inProgress.contains(item.id) {
            ProgressView()
        } else if downloads.isDownloaded(item.id) {
            Button { confirmingRemove = true } label: {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.accent)
            }
            .buttonStyle(.borderless)
            .confirmationDialog("Remove download?", isPresented: $confirmingRemove, titleVisibility: .visible) {
                Button("Remove download", role: .destructive) { Haptics.warning(); downloads.remove(item.id) }
                Button("Cancel", role: .cancel) {}
            }
        } else {
            Button {
                Task { await downloads.download(item); if downloads.isDownloaded(item.id) { Haptics.success() } }
            } label: {
                Image(systemName: "arrow.down.circle").foregroundStyle(Theme.ink3)
            }
            .buttonStyle(.borderless)
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
