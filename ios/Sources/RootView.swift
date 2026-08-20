import SwiftUI

struct RootView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(PlayerModel.self) private var player

    var body: some View {
        Group {
            if auth.isSignedIn {
                LibraryView()
                    .safeAreaInset(edge: .bottom, spacing: 0) { MiniPlayer() }
            } else {
                LoginView()
            }
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if !signedIn { player.stop() } // sign-out kills playback + mini-player
        }
    }
}
