import SwiftUI

@main
struct OtoApp: App {
    @State private var auth = AuthManager()
    @State private var player = PlayerModel() // one app-wide player — survives navigation

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .environment(player)
                .tint(Theme.accent)
        }
    }
}
