import SwiftUI

@main
struct OtoApp: App {
    @State private var auth = AuthManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .tint(Theme.accent)
        }
    }
}
