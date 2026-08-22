import SwiftUI

/// iOS 17–25 fallback: dock the mini-player inside the tab's content (per-tab
/// bottom inset) so it sits above — never over — the tab bar. On iOS 26 the
/// system slots it via `.tabViewBottomAccessory` and this modifier is inert.
private struct DockedMiniPlayer: ViewModifier {
    let docked: Bool
    func body(content: Content) -> some View {
        if docked {
            // MiniPlayer renders nothing when player.showsMiniPlayer is false, so this inset
            // contributes zero height (spacing is 0) — no empty bar when idle.
            content.safeAreaInset(edge: .bottom, spacing: 0) { MiniPlayer() }
        } else {
            content
        }
    }
}

/// iOS 26 draws the accessory capsule whenever the modifier is attached — an
/// empty builder still leaves a blank glass bar above the tab bar. The modifier
/// itself has to come off when there's no audio, and there is no
/// `tabViewBottomAccessory(isPresented:)` overload to do it for us.
@available(iOS 26.0, *)
private struct MiniPlayerAccessory: ViewModifier {
    let shows: Bool
    func body(content: Content) -> some View {
        if shows {
            content.tabViewBottomAccessory { MiniPlayer(inAccessory: true) }
        } else {
            content
        }
    }
}

struct RootView: View {
    private enum Tab { case library, explore, settings }

    @Environment(AuthManager.self) private var auth
    @Environment(PlayerModel.self) private var player
    @State private var showOnboarding = false
    @State private var tab: Tab = .library
    @State private var explorePath: [ExploreRoute] = []

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
        // Player sheet tapped an author → land on their profile in Explore.
        .onChange(of: player.requestedProfile) { _, username in
            guard let username else { return }
            player.requestedProfile = nil
            tab = .explore
            if explorePath.last != .user(username) {
                explorePath.append(.user(username))
            }
        }
        .onChange(of: auth.isSignedIn) { _, signedIn in
            if !signedIn { player.stop() } // sign-out kills playback + mini-player
        }
    }

    @ViewBuilder private var signedIn: some View {
        if #available(iOS 26.0, *) {
            // System slots the mini-player above the tab bar (Music-style capsule).
            TabView(selection: $tab) { tabs(docked: false) }
                .modifier(MiniPlayerAccessory(shows: player.showsMiniPlayer))
                .tabBarMinimizeBehavior(.onScrollDown)
        } else {
            TabView(selection: $tab) { tabs(docked: true) }
        }
    }

    @ViewBuilder private func tabs(docked: Bool) -> some View {
        LibraryView()
            .modifier(DockedMiniPlayer(docked: docked))
            .tabItem { Label("Library", systemImage: "books.vertical") }
            .tag(Tab.library)
        ExploreView(path: $explorePath)
            .modifier(DockedMiniPlayer(docked: docked))
            .tabItem { Label("Explore", systemImage: "safari") }
            .tag(Tab.explore)
        NavigationStack { SettingsView() }
            .modifier(DockedMiniPlayer(docked: docked))
            .tabItem { Label("Settings", systemImage: "gearshape") }
            .tag(Tab.settings)
    }
}
