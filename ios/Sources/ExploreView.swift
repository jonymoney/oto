import SwiftUI

/// Explore-feed / profile audio row: cover, title, @owner · duration.
/// Tap plays; context menu + trailing swipe save to library.
struct SocialAudioRow: View {
    @Environment(PlayerModel.self) private var player
    let item: AudioItem
    let saved: Bool
    let onSave: () -> Void

    var body: some View {
        Button {
            Haptics.tap()
            player.requestedItem = item
        } label: {
            HStack(spacing: 12) {
                CoverThumb(item: item, size: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title).lineLimit(1).foregroundStyle(Theme.ink)
                    HStack(spacing: 8) {
                        if let o = item.owner { Text("@\(o)") }
                        if let d = item.durationSec { Text(timecode(d)) }
                    }
                    .font(.caption).foregroundStyle(Theme.ink2)
                }
                Spacer(minLength: 8)
                if saved {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("Saved to library")
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.ink3)
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(Theme.surface)
        .contextMenu {
            if !saved {
                Button("Save to Library", systemImage: "plus.circle", action: onSave)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if !saved {
                Button("Save to Library", action: onSave).tint(Theme.accent)
            }
        }
    }
}

@MainActor
@Observable
final class ExploreModel {
    var payload: API.ExplorePayload?
    var followedUsers: [API.UserSummary] = []
    var followedNames: Set<String> = []
    var savedIds: Set<String> = []
    var searchResults: [API.UserSummary] = []
    var loading = false
    var failed = false

    func load(auth: AuthManager) async {
        loading = true
        failed = false
        do {
            payload = try await API.explore()
            followedUsers = try await API.following()
            followedNames = Set(followedUsers.map(\.username))
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            failed = payload == nil
        }
        loading = false
    }

    func search(_ q: String) async {
        do {
            searchResults = try await API.searchUsers(q: q)
        } catch {
            searchResults = []
        }
    }

    /// Single source of truth for follow state (search rows, Following row,
    /// profile button all read followedNames). Optimistic; reverts on failure.
    func setFollow(_ user: API.UserSummary, following: Bool) {
        following ? Haptics.success() : Haptics.tap() // only called from user taps
        apply(user, following: following)
        Task {
            do {
                if following { try await API.follow(username: user.username) }
                else { try await API.unfollow(username: user.username) }
            } catch {
                apply(user, following: !following)
            }
        }
    }

    /// Local-only state change (also used to sync a freshly loaded profile).
    func apply(_ user: API.UserSummary, following: Bool) {
        if following {
            followedNames.insert(user.username)
            if !followedUsers.contains(where: { $0.username == user.username }) {
                followedUsers.append(user)
            }
        } else {
            followedNames.remove(user.username)
            followedUsers.removeAll { $0.username == user.username }
        }
    }

    /// Optimistic save; reverts on failure.
    func save(_ item: AudioItem) {
        Haptics.success() // only called from user taps (context menu / swipe)
        savedIds.insert(item.id)
        Task {
            do { try await API.saveAudio(id: item.id) }
            catch { savedIds.remove(item.id) }
        }
    }
}

struct ExploreView: View {
    @Environment(AuthManager.self) private var auth
    /// Owned by RootView so the player sheet can push a profile onto this stack.
    @Binding var path: [ExploreRoute]
    @State private var model = ExploreModel()
    @State private var query = ""

    var body: some View {
        NavigationStack(path: $path) {
            content
                .background(Theme.bg)
                .navigationTitle("Explore")
                .searchable(text: $query, prompt: "Find people")
                .navigationDestination(for: ExploreRoute.self) { route in
                    switch route {
                    case .user(let username):
                        UserProfileView(username: username, explore: model)
                    case .tag(let tag):
                        TagFeedView(tag: tag, explore: model)
                    }
                }
                .refreshable { await model.load(auth: auth) }
                .task { await model.load(auth: auth) }
                .task(id: query) {
                    let q = query.trimmingCharacters(in: .whitespaces)
                    guard !q.isEmpty else { model.searchResults = []; return }
                    try? await Task.sleep(for: .milliseconds(300)) // debounce
                    guard !Task.isCancelled else { return }
                    await model.search(q)
                }
        }
    }

    @ViewBuilder private var content: some View {
        if !query.trimmingCharacters(in: .whitespaces).isEmpty {
            searchList
        } else if model.loading && model.payload == nil && model.followedUsers.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.failed && model.payload == nil {
            ContentUnavailableView {
                Label("Couldn't load", systemImage: "wifi.slash")
            } description: {
                Text("Check your connection and try again.")
            } actions: {
                Button("Retry") { Task { await model.load(auth: auth) } }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            feedList
        }
    }

    private var searchList: some View {
        List {
            ForEach(model.searchResults, id: \.username) { user in
                NavigationLink(value: ExploreRoute.user(user.username)) {
                    HStack(spacing: 12) {
                        AvatarImageView(username: user.username, avatarUrl: user.avatarUrl)
                        Text("@\(user.username)").foregroundStyle(Theme.ink)
                        Spacer()
                        followButton(for: user)
                    }
                }
                .listRowBackground(Theme.surface)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func followButton(for user: API.UserSummary) -> some View {
        let following = model.followedNames.contains(user.username)
        return Button(following ? "Following" : "Follow") {
            model.setFollow(user, following: !following)
        }
        .font(.subheadline.weight(.semibold))
        .buttonStyle(.bordered)
        .tint(following ? Theme.ink3 : Theme.accent)
    }

    private var feedList: some View {
        List {
            if !model.followedUsers.isEmpty {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 16) {
                            ForEach(model.followedUsers, id: \.username) { user in
                                NavigationLink(value: ExploreRoute.user(user.username)) {
                                    VStack(spacing: 4) {
                                        AvatarImageView(username: user.username, avatarUrl: user.avatarUrl, size: 52)
                                        Text("@\(user.username)")
                                            .font(.caption2).lineLimit(1)
                                            .foregroundStyle(Theme.ink2)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } header: {
                    Text("Following").foregroundStyle(Theme.ink2)
                }
                .listRowBackground(Theme.surface)
            }
            let follows = model.payload?.follows ?? []
            if !follows.isEmpty {
                railSection("New from people you follow", items: follows)
            }
            let forYou = model.payload?.forYou ?? []
            if !forYou.isEmpty {
                railSection("For you", items: forYou)
            }
            let tags = model.payload?.tags ?? []
            if !tags.isEmpty {
                topicsSection(tags)
            }
            let recent = model.payload?.recent ?? []
            Section {
                if recent.isEmpty {
                    Text("Nothing here yet — follow people to see more.")
                        .font(.subheadline).foregroundStyle(Theme.ink2)
                        .listRowBackground(Theme.surface)
                } else {
                    ForEach(recent) { item in
                        SocialAudioRow(item: item, saved: model.savedIds.contains(item.id)) {
                            model.save(item)
                        }
                    }
                }
            } header: {
                Text("Recent").foregroundStyle(Theme.ink2)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func railSection(_ title: String, items: [AudioItem]) -> some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(items) { item in
                        ExploreCard(item: item, saved: model.savedIds.contains(item.id)) {
                            model.save(item)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text(title).foregroundStyle(Theme.ink2)
        }
        .listRowBackground(Theme.surface)
    }

    private func topicsSection(_ tags: [API.TagCount]) -> some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(tags, id: \.self) { t in
                        NavigationLink(value: ExploreRoute.tag(t.tag)) {
                            HStack(spacing: 5) {
                                Text("#\(t.tag)")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Theme.ink)
                                Text("\(t.count)")
                                    .font(.caption)
                                    .foregroundStyle(Theme.ink3)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(Theme.bg))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text("Topics").foregroundStyle(Theme.ink2)
        }
        .listRowBackground(Theme.surface)
    }
}

/// Explore tab's navigation destinations, as a typed path so RootView can
/// inspect/push (e.g. "open this author's profile" from the player sheet).
enum ExploreRoute: Hashable {
    case user(String)
    case tag(String)
}

/// Horizontal-rail card: cover, 2-line title, @owner. Tap plays; long-press saves.
private struct ExploreCard: View {
    @Environment(PlayerModel.self) private var player
    let item: AudioItem
    let saved: Bool
    let onSave: () -> Void

    var body: some View {
        Button {
            Haptics.tap()
            player.requestedItem = item
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                CoverThumb(item: item, size: 120)
                Text(item.title)
                    .font(.footnote.weight(.medium))
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.leading)
                    .foregroundStyle(Theme.ink)
                if let o = item.owner {
                    Text("@\(o)").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            .frame(width: 140, alignment: .leading)
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !saved {
                Button("Save to Library", systemImage: "plus.circle", action: onSave)
            }
        }
    }
}

/// Pushed feed for a single #tag.
struct TagFeedView: View {
    @Environment(AuthManager.self) private var auth
    let tag: String
    /// Shared with ExploreView so save state stays consistent across screens.
    let explore: ExploreModel

    @State private var items: [AudioItem] = []
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        Group {
            if loading && items.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if failed && items.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "wifi.slash")
                } description: {
                    Text("Check your connection and try again.")
                } actions: {
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                List {
                    if items.isEmpty {
                        Text("Nothing here yet")
                            .font(.subheadline).foregroundStyle(Theme.ink2)
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Theme.surface)
                    } else {
                        ForEach(items) { item in
                            SocialAudioRow(item: item, saved: explore.savedIds.contains(item.id)) {
                                explore.save(item)
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            }
        }
        .background(Theme.bg)
        .navigationTitle("#\(tag)")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        loading = true
        failed = false
        do {
            items = try await API.tagAudios(tag: tag)
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            failed = items.isEmpty
        }
        loading = false
    }
}

struct UserProfileView: View {
    @Environment(AuthManager.self) private var auth
    let username: String
    /// Shared with ExploreView so follow/save state stays consistent across screens.
    let explore: ExploreModel

    @State private var profile: API.UserProfile?
    @State private var audios: [AudioItem] = []
    @State private var loading = true
    @State private var failed = false

    /// Follow state lives in the shared ExploreModel so this button, the search
    /// rows, and the Following row can never disagree.
    private var youFollow: Bool { explore.followedNames.contains(username) }

    var body: some View {
        Group {
            if loading && profile == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if failed && profile == nil {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "wifi.slash")
                } description: {
                    Text("Check your connection and try again.")
                } actions: {
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if let profile {
                List {
                    Section { header(profile).listRowBackground(Theme.bg) }
                        .listRowSeparator(.hidden)
                    Section {
                        if audios.isEmpty {
                            Text("Nothing public here (yet)")
                                .font(.subheadline).foregroundStyle(Theme.ink2)
                                .frame(maxWidth: .infinity)
                                .listRowBackground(Theme.surface)
                        } else {
                            ForEach(audios) { item in
                                SocialAudioRow(item: item, saved: explore.savedIds.contains(item.id)) {
                                    explore.save(item)
                                }
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.bg)
        .navigationTitle("@\(username)")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func header(_ profile: API.UserProfile) -> some View {
        VStack(spacing: 10) {
            AvatarImageView(username: profile.username, avatarUrl: profile.avatarUrl, size: 80)
            Text("@\(profile.username)")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.ink)
            Text("\(profile.counts.audios) audios · \(profile.counts.followers) followers · \(profile.counts.following) following")
                .font(.caption).foregroundStyle(Theme.ink2)
            Button(youFollow ? "Following" : "Follow") { toggleFollow() }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(youFollow ? Theme.ink3 : Theme.accent)
        }
        .frame(maxWidth: .infinity)
    }

    private func load() async {
        loading = true
        failed = false
        do {
            let p = try await API.userProfile(username: username)
            profile = p
            // Server wins over any stale local follow state.
            explore.apply(.init(username: p.username, avatarUrl: p.avatarUrl), following: p.youFollow)
            audios = try await API.userAudios(username: username)
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            failed = true
        }
        loading = false
    }

    private func toggleFollow() {
        guard let profile else { return }
        explore.setFollow(.init(username: profile.username, avatarUrl: profile.avatarUrl),
                          following: !youFollow)
    }
}
