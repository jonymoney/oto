import SwiftUI

/// iOS 17–25 fallback: dock the mini-player inside the tab's content (per-tab
/// bottom inset) so it sits above — never over — the tab bar. On iOS 26 the
/// system slots it via `.tabViewBottomAccessory` and this modifier is inert.
private struct DockedMiniPlayer: ViewModifier {
    let docked: Bool
    func body(content: Content) -> some View {
        if docked {
            // MiniPlayer renders nothing when player.item == nil, so this inset
            // contributes zero height (spacing is 0) — no empty bar when idle.
            content.safeAreaInset(edge: .bottom, spacing: 0) { MiniPlayer() }
        } else {
            content
        }
    }
}

struct RootView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(PlayerModel.self) private var player
    @State private var showOnboarding = false

    var body: some View {
        Group {
            if auth.isSignedIn {
                signedIn
                    .onAppear { Haptics.prepare(); showOnboarding = Onboarding.needed }
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
        .onChange(of: player.requestedItem?.id) { _, id in
            if id != nil { Haptics.impact() } // full player sheet presenting
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if !signedIn { player.stop() } // sign-out kills playback + mini-player
        }
    }

    @ViewBuilder private var signedIn: some View {
        if #available(iOS 26.0, *) {
            // System slots the mini-player above the tab bar (Music-style capsule).
            // Verified on the iOS 26.0 simulator: when the builder's `if` is
            // false the system removes the capsule entirely (no empty accessory,
            // no reserved space) and restores it when an item loads — so keep
            // the condition here, inside the builder, not around the modifier
            // (branching around TabView would reset tab/scroll state).
            TabView { tabs(docked: false) }
                .tabViewBottomAccessory {
                    if player.item != nil { MiniPlayer(inAccessory: true) }
                }
                .tabBarMinimizeBehavior(.onScrollDown)
        } else {
            TabView { tabs(docked: true) }
        }
    }

    @ViewBuilder private func tabs(docked: Bool) -> some View {
        LibraryView()
            .modifier(DockedMiniPlayer(docked: docked))
            .tabItem { Label("Library", systemImage: "books.vertical") }
        ExploreView()
            .modifier(DockedMiniPlayer(docked: docked))
            .tabItem { Label("Explore", systemImage: "safari") }
        NavigationStack { SettingsView() }
            .modifier(DockedMiniPlayer(docked: docked))
            .tabItem { Label("Settings", systemImage: "gearshape") }
    }
}
