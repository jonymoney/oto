import SwiftUI
import AVFoundation
import Combine
import MediaPlayer

@MainActor
@Observable
final class PlayerModel {
    var detail: AudioDetail?
    var loading = true
    var errorMessage: String?
    private(set) var hasAudio = false
    private(set) var playing = false
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    private(set) var speed: Float = 1

    private var player: AVPlayer?
    private var item: AudioItem?
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []

    func load(item: AudioItem, auth: AuthManager) async {
        self.item = item
        loading = true; errorMessage = nil
        duration = item.durationSec ?? 0
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        // Downloaded → play the local file, offline and instant; skip the fetch.
        if let local = Downloads.shared.localURL(item.id) {
            attach(AVPlayer(url: local))
            loading = false
            return
        }
        do {
            let d = try await API.audioDetail(id: item.id)
            detail = d
            if let ds = d.durationSec { duration = ds }
            if let urlStr = d.audioUrl, let url = URL(string: urlStr) {
                attach(AVPlayer(url: url))
            }
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            errorMessage = "Couldn't load this audio."
        }
        loading = false
    }

    private func attach(_ p: AVPlayer) {
        player = p
        p.defaultRate = speed
        hasAudio = true
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
                    self?.playing = status != .paused
                    self?.updateNowPlaying()
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
        updateNowPlaying()
    }

    private func ended() {
        player?.pause()
        player?.seek(to: .zero)
        position = 0
        updateNowPlaying()
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

    func stop() {
        player?.pause()
        if let t = timeObserver { player?.removeTimeObserver(t) }
        timeObserver = nil
        cancellables.removeAll()
        teardownRemoteCommands()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        player = nil
        playing = false
    }

    // MARK: Now Playing / lock screen

    private func updateNowPlaying() {
        guard let item else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.voice,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: player?.rate ?? 0,
        ]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
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

struct PlayerView: View {
    let item: AudioItem
    @Environment(AuthManager.self) private var auth
    @State private var model = PlayerModel()
    @State private var scrub: Double?                       // drag-in-progress target
    @State private var coverImage = Image(systemName: "waveform")

    private static let speeds: [Float] = [1, 1.25, 1.5, 2]

    private var summary: String? { model.detail?.summary ?? item.summary }
    private var tags: [String] { model.detail?.tags ?? item.tags }
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
                    CoverView(id: item.id, mood: model.detail?.mood ?? item.mood, size: side)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(alignment: .bottomTrailing) {
                            let emoji = model.detail?.emoji ?? item.emoji
                            if let e = emoji, !e.isEmpty {
                                Text(e)
                                    .font(.system(size: side * 0.16))
                                    .padding(side * 0.05)
                                    .background(.thinMaterial, in: Circle())
                                    .padding(10)
                            }
                        }
                        .frame(maxWidth: .infinity)
                }
                .frame(height: 300)

                VStack(spacing: 8) {
                    Text(item.title).font(.title2).bold().multilineTextAlignment(.center)
                        .foregroundStyle(Theme.ink)
                    Text(item.voice).foregroundStyle(Theme.ink2)
                    if let s = summary, !s.isEmpty {
                        Text(s).font(.subheadline).foregroundStyle(Theme.ink2)
                            .multilineTextAlignment(.center)
                    }
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
                }

                if model.loading {
                    ProgressView()
                } else if let err = model.errorMessage {
                    Text(err).foregroundStyle(Theme.danger)
                } else {
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
                    }
                    .disabled(!model.hasAudio)

                    HStack(spacing: 44) {
                        Button { model.skip(-15) } label: {
                            Image(systemName: "gobackward.15").font(.title)
                        }
                        Button { model.toggle() } label: {
                            Image(systemName: model.playing ? "pause.circle.fill" : "play.circle.fill")
                                .font(.system(size: 72))
                        }
                        Button { model.skip(15) } label: {
                            Image(systemName: "goforward.15").font(.title)
                        }
                    }
                    .foregroundStyle(Theme.accent)
                    .disabled(!model.hasAudio)

                    Menu {
                        ForEach(Self.speeds, id: \.self) { s in
                            Button(speedLabel(s)) { model.setSpeed(s) }
                        }
                    } label: {
                        Text(speedLabel(model.speed))
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.ink2)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Theme.surface, in: Capsule())
                            .overlay(Capsule().stroke(Theme.line))
                    }
                    .disabled(!model.hasAudio)
                }
            }
            .padding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: shareURL, preview: SharePreview(item.title, image: coverImage))
            }
        }
        .task {
            // Render the deterministic cover locally for the share preview —
            // identical art to the server's cover.png, works offline.
            let renderer = ImageRenderer(content: CoverView(id: item.id, mood: item.mood, size: 300))
            renderer.scale = 2
            if let ui = renderer.uiImage { coverImage = Image(uiImage: ui) }
            await model.load(item: item, auth: auth)
        }
        .onDisappear { model.stop() }
    }

    private func speedLabel(_ s: Float) -> String {
        String(format: "%gx", s)
    }
}
