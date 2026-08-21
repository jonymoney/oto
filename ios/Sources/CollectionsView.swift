import SwiftUI

/// User's collections: list, create, delete; tap through to the items.
struct CollectionsView: View {
    @Environment(AuthManager.self) private var auth
    @State private var collections: [API.Collection] = []
    @State private var loaded = false
    @State private var creating = false
    @State private var newName = ""
    @State private var pendingDelete: API.Collection?

    var body: some View {
        Group {
            if collections.isEmpty {
                if loaded {
                    ContentUnavailableView("No collections", systemImage: "folder",
                        description: Text("Group audios from your library's context menu, or create one with +."))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                List {
                    ForEach(collections) { c in
                        NavigationLink {
                            CollectionDetailView(collection: c)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder.fill").foregroundStyle(Theme.accent)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.name).foregroundStyle(Theme.ink)
                                    Text("\(c.count) audio\(c.count == 1 ? "" : "s")")
                                        .font(.caption).foregroundStyle(Theme.ink2)
                                }
                            }
                        }
                        .listRowBackground(Theme.surface)
                        .swipeActions(edge: .trailing) {
                            Button("Delete", role: .destructive) { pendingDelete = c }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.bg)
        .navigationTitle("Collections")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New collection")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .alert("New collection", isPresented: $creating) {
            TextField("Name", text: $newName)
            Button("Create") {
                let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                newName = ""
                guard (1...60).contains(name.count) else { return }
                Task {
                    _ = try? await API.createCollection(name: name)
                    await load()
                }
            }
            Button("Cancel", role: .cancel) { newName = "" }
        }
        .confirmationDialog(
            "Delete \"\(pendingDelete?.name ?? "")\"?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete collection", role: .destructive) {
                guard let c = pendingDelete else { return }
                pendingDelete = nil
                Task {
                    try? await API.deleteCollection(id: c.id)
                    await load()
                }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("Audios stay in your library.")
        }
    }

    private func load() async {
        do {
            collections = try await API.collections()
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            // Keep whatever we had; empty state doubles as the error state.
        }
        loaded = true
    }
}

/// One collection's items — library-style rows, tap to play.
struct CollectionDetailView: View {
    let collection: API.Collection
    @Environment(PlayerModel.self) private var player
    @State private var items: [AudioItem]?

    var body: some View {
        Group {
            if let items {
                if items.isEmpty {
                    ContentUnavailableView("Empty collection", systemImage: "folder",
                        description: Text("Add audios from your library's context menu."))
                } else {
                    List {
                        ForEach(items) { item in
                            row(for: item)
                        }
                    }
                    .scrollContentBackground(.hidden)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bg)
        .navigationTitle(collection.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func row(for item: AudioItem) -> some View {
        Button {
            player.requestedItem = item
        } label: {
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
                    }
                    .font(.caption).foregroundStyle(Theme.ink2)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.ink3)
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(Theme.surface)
        .swipeActions(edge: .trailing) {
            Button("Remove", systemImage: "folder.badge.minus") {
                Task {
                    try? await API.removeFromCollection(id: collection.id, audioId: item.id)
                    await load()
                }
            }
            .tint(Theme.ink3)
        }
    }

    private func load() async {
        items = (try? await API.collection(id: collection.id))?.items ?? items
    }
}
