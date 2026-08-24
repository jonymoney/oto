import SwiftUI
import AVFoundation
import Combine
import MediaPlayer

/// Local mirror of the last reported playback position per audio id, so
/// downloaded/offline playback resumes too and syncs opportunistically later.
enum ResumeStore {
    private static let key = "resumePositions"

    static func get(_ id: String) -> Double? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: Double])?[id]
    }

    static func set(_ id: String, _ positionSec: Double) {
        var d = (UserDefaults.standard.dictionary(forKey: key) as? [String: Double]) ?? [:]
        if positionSec <= 0 { d.removeValue(forKey: id) } else { d[id] = positionSec }
        UserDefaults.standard.set(d, forKey: key)
    }

    /// Sign-out wipe — positions belong to the account that listened.
    static func wipe() { UserDefaults.standard.removeObject(forKey: key) }
}

@MainActor
@Observable
final class PlayerModel {
    var detail: AudioDetail?
    var loading = true
    var errorMessage: String?
    /// Setting this presents the full player sheet from the root (RootView
    /// binds `.sheet(item:)` to it); dismissing the sheet clears it back to nil.
    var requestedItem: AudioItem?
    /// Set when the user taps an author in the player; RootView routes it onto
    /// the Explore tab's profile stack and clears it back to nil.
    var requestedProfile: String?
    private(set) var item: AudioItem?
    private(set) var hasAudio = false
    /// Single gate for every mini-player mount point: show it only when audio
    /// is actually loaded (playing or paused). `item` alone isn't enough —
    /// load() sets it before the fetch, so an error or a still-generating
    /// audio would leave a dead bar after the sheet is dismissed.
    var showsMiniPlayer: Bool { hasAudio && item != nil }
    private(set) var playing = false
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    private(set) var speed: Float = 1

    private var player: AVPlayer?
    private var artwork: MPMediaItemArtwork? // rendered once per item; updateNowPlaying ticks 2x/sec
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []
    private var lastReportAt = Date.distantPast

    func load(item: AudioItem, auth: AuthManager) async {
        // Re-opening the currently loaded (or in-flight) audio → keep playing as-is.
        if let cur = self.item, cur.id == item.id, hasAudio || loading { return }
        teardown() // switching audios: stop the old one
        detail = nil
        hasAudio = false
        position = 0
        self.item = item
        artwork = Self.renderArtwork(for: item)
        loading = true; errorMessage = nil
        duration = item.durationSec ?? 0
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        // Downloaded → play the local file, offline and instant; skip the fetch.
        if let local = Downloads.shared.localURL(item.id) {
            attach(AVPlayer(url: local))
            resumeIfNeeded()
            loading = false
            return
        }
        do {
            let d = try await API.audioDetail(id: item.id)
            detail = d
            if let ds = d.durationSec { duration = ds }
            if let urlStr = d.audioUrl, let url = URL(string: urlStr) {
                attach(AVPlayer(url: url))
                resumeIfNeeded()
            }
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            errorMessage = String(localized: "Couldn't load this audio.")
        }
        loading = false
    }

    private func attach(_ p: AVPlayer) {
        player = p
        p.defaultRate = speed
        hasAudio = true
        lastReportAt = .now // first periodic report ~5s into playback
        timeObserver = p.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time) }
        }
        // Mirror the real player state so the play/pause icon never desyncs
        // (buffering, remote pauses, route changes, end of playback).
        p.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let wasPlaying = self.playing
                    self.playing = status != .paused
                    if wasPlaying && !self.playing { self.report() } // pause → save position
                    self.updateNowPlaying()
                }
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification, object: p.currentItem)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated { self?.ended() }
            }
            .store(in: &cancellables)
        setupRemoteCommands()
    }

    private func tick(_ time: CMTime) {
        position = max(time.seconds, 0)
        if let d = player?.currentItem?.duration, d.isNumeric, d.seconds > 0 {
            duration = d.seconds
        }
        if playing, Date.now.timeIntervalSince(lastReportAt) >= 5 { report() }
        updateNowPlaying()
    }

    private func ended() {
        player?.pause()
        player?.seek(to: .zero)
        position = 0
        report(0) // finished → clear the saved position
        updateNowPlaying()
    }

    // MARK: Continue Listening

    /// Persist the position: local mirror always (offline resume), server
    /// best-effort. Called throttled from tick, plus on pause/stop/switch/end.
    private func report(_ positionSec: Double? = nil) {
        guard let item, hasAudio else { return }
        let p = max(positionSec ?? position, 0)
        ResumeStore.set(item.id, p)
        API.reportPosition(id: item.id, positionSec: p)
        lastReportAt = .now
    }

    /// Audible-style auto-resume: seek to the saved position (server value from
    /// detail, else the local mirror) when it's meaningfully mid-audio.
    private func resumeIfNeeded() {
        guard let item else { return }
        let saved = detail?.positionSec ?? ResumeStore.get(item.id) ?? 0
        guard saved > 5, duration > 0, saved < duration - 5 else { return }
        seek(to: saved)
    }

    func toggle() {
        guard let player else { return }
        if playing { player.pause() } else { player.play() } // play() resumes at defaultRate
    }

    func seek(to seconds: Double) {
        position = seconds
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600),
                     toleranceBefore: .zero, toleranceAfter: .zero)
        updateNowPlaying()
    }

    func skip(_ delta: Double) {
        var target = max(position + delta, 0)
        if duration > 0 { target = min(target, duration) }
        seek(to: target)
    }

    func setSpeed(_ s: Float) {
        speed = s
        player?.defaultRate = s
        if playing { player?.rate = s }
    }

    // Sleep timer: pauses playback when it fires. nil = off.
    private(set) var sleepMinutes: Int?
    private var sleepTask: Task<Void, Never>?

    func setSleepTimer(minutes: Int?) {
        sleepTask?.cancel()
        sleepMinutes = minutes
        guard let minutes else { sleepTask = nil; return }
        sleepTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Double(minutes) * 60))
            guard !Task.isCancelled, let self else { return }
            if self.playing { self.toggle() }
            self.sleepMinutes = nil
        }
    }

    func stop() {
        teardown()
        requestedItem = nil // dismisses the full player sheet if presented
        item = nil
        artwork = nil
        detail = nil
        hasAudio = false
        position = 0
        duration = 0
    }

    private func teardown() {
        report() // switching/stopping mid-audio → save where we left off
        sleepTask?.cancel()
        sleepMinutes = nil
        player?.pause()
        if let t = timeObserver { player?.removeTimeObserver(t) }
        timeObserver = nil
        cancellables.removeAll()
        teardownRemoteCommands()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        player = nil
        playing = false
    }

    /// One generation-status poll: re-fetch detail and attach once the audio
    /// URL appears. Transient failures are silent — the caller keeps polling.
    func pollGenerating() async {
        guard let item, !hasAudio else { return }
        guard let d = try? await API.audioDetail(id: item.id) else { return }
        detail = d
        if let ds = d.durationSec { duration = ds }
        if let urlStr = d.audioUrl, let url = URL(string: urlStr) {
            attach(AVPlayer(url: url))
        }
    }

    // MARK: Now Playing / lock screen

    private func updateNowPlaying() {
        guard let item else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.voice,
            MPMediaItemPropertyAlbumTitle: "oto",
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: player?.rate ?? 0,
        ]
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Same deterministic cover as CoverView on screen (same seed/mood → same art),
    /// rendered to a 1024px UIImage for the lock screen / CarPlay.
    private static func renderArtwork(for item: AudioItem) -> MPMediaItemArtwork? {
        // Warm the ground-bitmap cache synchronously (off the scroll hot path)
        // so ImageRenderer captures the real art, not the async placeholder.
        CoverRenderer.prewarm(id: item.id, mood: item.mood, style: item.coverStyle,
                              emoji: item.emoji, size: 512)
        let renderer = ImageRenderer(content: CoverView(
            id: item.id, mood: item.mood, size: 512, style: item.coverStyle,
            title: item.title,
            meta: coverMeta(durationSec: item.durationSec, language: item.language),
            emoji: item.emoji
        ))
        renderer.scale = 2
        guard let ui = renderer.uiImage else { return nil }
        return artworkWrapping(ui)
    }

    // MediaPlayer invokes the request handler on its own queue; the closure must
    // NOT inherit MainActor isolation or the executor check traps (SIGTRAP).
    private nonisolated static func artworkWrapping(_ ui: UIImage) -> MPMediaItemArtwork {
        // UIImage is immutable/thread-safe; the handler may run off-main.
        MPMediaItemArtwork(boundsSize: ui.size) { _ in ui }
    }

    private func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.player?.play() }
            return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.player?.pause() }
            return .success
        }
        c.skipForwardCommand.preferredIntervals = [15]
        c.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.skip(15) }
            return .success
        }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.skip(-15) }
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let pos = e.positionTime
            Task { @MainActor in self?.seek(to: pos) }
            return .success
        }
    }

    private func teardownRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        // ponytail: removeTarget(nil) clears all targets — fine while one player
        // screen exists at a time; use tokens if that ever changes.
        [c.playCommand, c.pauseCommand, c.skipForwardCommand,
         c.skipBackwardCommand, c.changePlaybackPositionCommand].forEach { $0.removeTarget(nil) }
    }
}

// Reports the inline player's bottom edge in the scroll viewport, so the nav
// bar knows when the controls are out of sight.
private struct ControlsMaxYKey: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = min(value, nextValue())
    }
}

struct PlayerView: View {
    let item: AudioItem
    @Environment(AuthManager.self) private var auth
    @Environment(PlayerModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var scrub: Double?                       // drag-in-progress target
    @State private var coverImage = Image(systemName: "waveform")
    @State private var localVisibility: String?             // optimistic PATCH result
    @State private var showDeleteConfirm = false
    @State private var controlsOffscreen = false            // drives the compact nav header
    @State private var collections: [API.Collection] = []   // fetched on collection-button tap
    @State private var addedToCollection = false            // brief checkmark confirmation

    private static let speeds: [Float] = [1, 1.25, 1.5, 2]
    private static let visibilities: [(value: String, icon: String)] = [
        ("private", "lock"), ("followers", "person.2"),
        ("friends", "person.2.fill"), ("public", "globe"),
    ]

    private var summary: String? { model.detail?.summary ?? item.summary }
    private var tags: [String] { model.detail?.tags ?? item.tags }
    /// nil = the current user's own audio.
    private var owner: String? { model.detail?.owner ?? item.owner }
    private var authorLabel: String { owner.map { "@\($0)" } ?? String(localized: "Me") }
    private var visibility: String {
        localVisibility ?? model.detail?.visibility ?? item.visibility ?? "private"
    }
    private var clientName: String? { model.detail?.clientName ?? item.clientName }
    // Short link from the API; /a/{id} fallback keeps stale cached lists sharable.
    private var shareURL: URL {
        URL(string: model.detail?.shareUrl ?? item.shareUrl ?? "")
            ?? URL(string: "https://oto.audio/a/\(item.id)")!
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                GeometryReader { geo in
                    let side = min(geo.size.width, 300)
                    // Big tier (≥160pt): CoverView composes the editorial type
                    // layer (title/meta/emoji) itself, so no emoji chip here.
                    CoverView(
                        id: item.id, mood: model.detail?.mood ?? item.mood, size: side,
                        style: model.detail?.coverStyle ?? item.coverStyle,
                        title: item.title,
                        meta: coverMeta(
                            durationSec: model.detail?.durationSec ?? item.durationSec,
                            language: model.detail?.language ?? item.language
                        ),
                        emoji: model.detail?.emoji ?? item.emoji
                    )
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .frame(maxWidth: .infinity)
                }
                .frame(height: 300)

                VStack(alignment: .leading, spacing: 10) {
                    if !tags.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(tags, id: \.self) { tag in
                                    Text(tag)
                                        .font(.caption)
                                        .foregroundStyle(Theme.ink2)
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(Theme.surface, in: Capsule())
                                        .overlay(Capsule().stroke(Theme.line))
                                }
                            }
                            .padding(.horizontal, 2)
                        }
                    }
                    Text(item.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(Theme.ink)
                    // Identity row: author is the anchor; visibility rides along.
                    HStack(spacing: 8) {
                        // The audio payload carries no avatar URL, so this renders from
                        // the on-device cache (populated by Settings/Explore); add
                        // ownerAvatarUrl to the API if cold-start matters.
                        AvatarImageView(username: owner, avatarUrl: nil, size: 22)
                        if let o = owner {
                            Button { openProfile(o) } label: {
                                Text(authorLabel)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.ink)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Text(authorLabel)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                            visibilityMenu
                        }
                        Spacer()
                        collectionButton
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if model.loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let err = model.errorMessage {
                    Text(err).foregroundStyle(Theme.danger)
                } else if !model.hasAudio {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Generating audio…")
                    }
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
                } else {
                    // Inline player (Spotify episode layout). Its frame is
                    // reported so the nav bar can take over once it scrolls away.
                    inlinePlayer
                        .background(GeometryReader { geo in
                            Color.clear.preference(
                                key: ControlsMaxYKey.self,
                                value: geo.frame(in: .named("playerScroll")).maxY
                            )
                        })
                }

                aboutCard
                if let o = owner { authorCard(o) }
            }
            .padding()
        }
        .coordinateSpace(name: "playerScroll")
        .onPreferenceChange(ControlsMaxYKey.self) { maxY in
            // Spotify behavior: the compact header (title + mini play) appears
            // only when the real controls have scrolled off the top.
            let off = maxY < 10
            if off != controlsOffscreen {
                withAnimation(.easeInOut(duration: 0.18)) { controlsOffscreen = off }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .navigationTitle("")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            // Long titles overflow the nav bar — author lives there; once the
            // inline player scrolls away, title + mini play take over.
            ToolbarItem(placement: .principal) {
                if controlsOffscreen {
                    VStack(spacing: 0) {
                        Text(item.title)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        Text(authorLabel)
                            .font(.caption2)
                            .foregroundStyle(Theme.ink2)
                    }
                } else {
                    Text(authorLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if controlsOffscreen, model.hasAudio {
                    Button { Haptics.tap(); model.toggle() } label: {
                        Image(systemName: model.playing ? "pause.circle.fill" : "play.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Theme.accent)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if owner == nil {
                    Menu {
                        ShareLink(item: shareURL, preview: SharePreview(item.title, image: coverImage))
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            Haptics.warning()
                            showDeleteConfirm = true
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                } else {
                    ShareLink(item: shareURL, preview: SharePreview(item.title, image: coverImage))
                }
            }
        }
        .confirmationDialog(
            "Delete this audio? It also disappears for anyone who saved it. This cannot be undone.",
            isPresented: $showDeleteConfirm, titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                Task {
                    guard (try? await API.deleteAudio(id: item.id)) != nil else { return }
                    Haptics.success()
                    model.stop() // teardown + clears requestedItem (dismisses the sheet)
                    dismiss()    // covers a navigation-pushed presentation too
                }
            }
        }
        .task {
            // Render the deterministic cover locally for the share preview —
            // identical art to the server's cover.png, works offline. Await the
            // ground bitmap first (off-main; also feeds the on-screen cover)
            // so ImageRenderer captures the real art, not the placeholder.
            _ = await CoverRenderer.image(id: item.id, mood: item.mood,
                                          style: item.coverStyle, emoji: item.emoji, size: 300)
            let renderer = ImageRenderer(content: CoverView(
                id: item.id, mood: item.mood, size: 300, style: item.coverStyle,
                title: item.title,
                meta: coverMeta(durationSec: item.durationSec, language: item.language),
                emoji: item.emoji
            ))
            renderer.scale = 2
            if let ui = renderer.uiImage { coverImage = Image(uiImage: ui) }
            await model.load(item: item, auth: auth)
            // Still generating server-side → poll until the audio URL appears.
            // The .task is cancelled on disappear, which ends the loop.
            while !Task.isCancelled, model.item?.id == item.id,
                  !model.hasAudio, model.errorMessage == nil {
                try? await Task.sleep(for: .seconds(4))
                await model.pollGenerating()
            }
        }
    }

    /// Inline player: scrubber + one Spotify-style control row
    /// (speed · back 15 · play · fwd 15 · sleep timer).
    private var inlinePlayer: some View {
        VStack(spacing: 4) {
            Slider(
                value: Binding(get: { scrub ?? model.position }, set: { scrub = $0 }),
                in: 0...max(model.duration, 1)
            ) { editing in
                if !editing, let s = scrub { model.seek(to: s); scrub = nil }
            }
            .tint(Theme.accent)
            HStack {
                Text(timecode(scrub ?? model.position))
                Spacer()
                Text(timecode(model.duration))
            }
            .font(.caption.monospacedDigit()).foregroundStyle(Theme.ink2)

            HStack {
                // Tap cycles 1x → 1.25x → 1.5x → 2x → back to 1x.
                Button {
                    Haptics.selection()
                    let i = Self.speeds.firstIndex(of: model.speed) ?? 0
                    model.setSpeed(Self.speeds[(i + 1) % Self.speeds.count])
                } label: {
                    Text(speedLabel(model.speed))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.ink)
                        .contentTransition(.numericText())
                        .frame(width: 44, alignment: .leading)
                }
                .animation(.snappy(duration: 0.2), value: model.speed)
                Spacer()
                Button { Haptics.tap(); model.skip(-15) } label: {
                    Image(systemName: "gobackward.15").font(.title2)
                }
                Spacer()
                Button { Haptics.tap(); model.toggle() } label: {
                    Image(systemName: model.playing ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 60))
                }
                Spacer()
                Button { Haptics.tap(); model.skip(15) } label: {
                    Image(systemName: "goforward.15").font(.title2)
                }
                Spacer()
                sleepMenu
            }
            .foregroundStyle(Theme.accent)
        }
        .padding(.vertical, 6)
    }

    private static let createdAtParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private var metaLine: String {
        var parts: [String] = []
        let iso = Self.createdAtParser.date(from: item.createdAt)
            ?? ISO8601DateFormatter().date(from: item.createdAt)
        if let d = iso { parts.append(d.formatted(date: .abbreviated, time: .omitted)) }
        parts.append(item.voice)
        if let c = clientName { parts.append(String(localized: "made with \(c)")) }
        return parts.joined(separator: " · ")
    }

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("About this audio")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
            if let s = summary, !s.isEmpty {
                Text(s).font(.subheadline).foregroundStyle(Theme.ink2)
            }
            Text(metaLine)
                .font(.caption)
                .foregroundStyle(Theme.ink2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.line))
    }

    /// Attribution card — tapping opens the author's profile on the Explore tab.
    private func authorCard(_ username: String) -> some View {
        Button { openProfile(username) } label: {
            HStack(spacing: 10) {
                // Renders from the on-device avatar cache — the payload has no avatar URL.
                AvatarImageView(username: username, avatarUrl: nil, size: 36)
                Text("@\(username)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.ink3)
            }
            .padding(14)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.line))
        }
        .buttonStyle(.plain)
    }

    /// Dismiss the sheet and hand the profile jump to RootView (it switches to
    /// Explore and pushes unless that profile is already on top of the stack).
    private func openProfile(_ username: String) {
        Haptics.tap()
        model.requestedProfile = username
        model.requestedItem = nil // dismisses the full player sheet
        dismiss()                 // covers a navigation-pushed presentation too
    }

    /// Quiet add-to-collection: a Menu like the visibility switcher (an action
    /// sheet presented over this sheet drops its button taps). Collections are
    /// fetched on appear — that same GET also makes the server create the
    /// default "Favorites" for new users.
    private var collectionButton: some View {
        Menu {
            ForEach(collections) { c in
                Button(c.name) { add(to: c) }
            }
        } label: {
            Image(systemName: addedToCollection ? "checkmark.circle.fill" : "plus.circle")
                .font(.title3)
                .foregroundStyle(addedToCollection ? Theme.accent : Theme.ink2)
        }
        .accessibilityLabel("Add to collection")
        .task { collections = (try? await API.collections()) ?? [] }
    }

    private func add(to c: API.Collection) {
        Task {
            guard (try? await API.addToCollection(id: c.id, audioId: item.id)) != nil else { return }
            Haptics.success()
            withAnimation { addedToCollection = true }
            try? await Task.sleep(for: .seconds(1.5))
            withAnimation { addedToCollection = false }
        }
    }

    private var sleepMenu: some View {
        Menu {
            Button("Off") { model.setSleepTimer(minutes: nil) }
            ForEach([5, 15, 30, 45], id: \.self) { m in
                Button {
                    Haptics.selection()
                    model.setSleepTimer(minutes: m)
                } label: {
                    if model.sleepMinutes == m {
                        Label("\(m) min", systemImage: "checkmark")
                    } else {
                        Text("\(m) min")
                    }
                }
            }
        } label: {
            Image(systemName: "timer")
                .font(.title2)
                .foregroundStyle(model.sleepMinutes == nil ? Theme.accent : Theme.ink)
                .frame(width: 44, alignment: .trailing)
        }
    }

    /// Compact capsule menu switching the audio's visibility (own audios only).
    private var visibilityMenu: some View {
        Menu {
            ForEach(Self.visibilities, id: \.value) { v in
                Button {
                    guard v.value != visibility else { return }
                    Task {
                        if (try? await API.setVisibility(audioId: item.id, v.value)) != nil {
                            localVisibility = v.value
                            Haptics.selection()
                        }
                    }
                } label: {
                    if v.value == visibility {
                        Label(visibilityLabel(v.value), systemImage: "checkmark")
                    } else {
                        Label(visibilityLabel(v.value), systemImage: v.icon)
                    }
                }
            }
        } label: {
            let icon = Self.visibilities.first { $0.value == visibility }?.icon ?? "lock"
            Label(visibilityLabel(visibility), systemImage: icon)
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.ink2)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.surface, in: Capsule())
                .overlay(Capsule().stroke(Theme.line))
        }
    }

    private func speedLabel(_ s: Float) -> String {
        String(format: "%gx", s)
    }
}
