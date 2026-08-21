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
        // Single presentation path for the full player: anything (mini-player,
        // library rows) sets player.requestedItem; dismissing clears it.
        .sheet(item: Binding(
            get: { player.requestedItem },
            set: { player.requestedItem = $0 }
        )) { item in
            NavigationStack { PlayerView(item: item) }
                .presentationDragIndicator(.visible)
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if !signedIn { player.stop() } // sign-out kills playback + mini-player
        }
    }
}
