import SwiftUI

struct RootView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(PlayerModel.self) private var player
    @State private var showOnboarding = false

    var body: some View {
        Group {
            if auth.isSignedIn {
                TabView {
                    LibraryView()
                        .tabItem { Label("Library", systemImage: "books.vertical") }
                    ExploreView()
                        .tabItem { Label("Explore", systemImage: "safari") }
                    NavigationStack { SettingsView() }
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                }
                // On the TabView (not inside a tab) so the mini-player floats
                // above the tab bar on every tab.
                .safeAreaInset(edge: .bottom, spacing: 0) { MiniPlayer() }
                .onAppear { showOnboarding = Onboarding.needed }
                .fullScreenCover(isPresented: $showOnboarding) {
                    OnboardingView(done: { showOnboarding = false })
                }
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
