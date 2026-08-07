import SwiftUI
import AVFoundation

@MainActor
@Observable
final class PlayerModel {
    var detail: AudioDetail?
    var loading = true
    var errorMessage: String?
    private var player: AVPlayer?
    private(set) var playing = false

    func load(id: String, auth: AuthManager) async {
        loading = true; errorMessage = nil
        do {
            let d = try await API.audioDetail(id: id)
            detail = d
            if let urlStr = d.audioUrl, let url = URL(string: urlStr) {
                try? AVAudioSession.sharedInstance().setCategory(.playback)
                try? AVAudioSession.sharedInstance().setActive(true)
                player = AVPlayer(url: url)
            }
        } catch APIError.unauthorized {
            auth.sessionExpired()
        } catch {
            errorMessage = "Couldn't load this audio."
        }
        loading = false
    }

    func toggle() {
        guard let player else { return }
        if playing { player.pause() } else { player.play() }
        playing.toggle()
    }

    func stop() { player?.pause(); playing = false }
}

struct PlayerView: View {
    let item: AudioItem
    @Environment(AuthManager.self) private var auth
    @State private var model = PlayerModel()

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 96)).foregroundStyle(Theme.accent)
            Text(item.title).font(.title2).bold().multilineTextAlignment(.center)
                .foregroundStyle(Theme.ink)
            Text(item.voice).foregroundStyle(Theme.ink2)

            if model.loading {
                ProgressView()
            } else if let err = model.errorMessage {
                Text(err).foregroundStyle(Theme.danger)
            } else {
                Button {
                    model.toggle()
                } label: {
                    Image(systemName: model.playing ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 72))
                        .foregroundStyle(Theme.accent)
                }
                .disabled(model.detail?.audioUrl == nil)
            }
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(id: item.id, auth: auth) }
        .onDisappear { model.stop() }
    }
}
