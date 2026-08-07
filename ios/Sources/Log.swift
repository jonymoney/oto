import OSLog

// Unified logging. Visible in Xcode's console and Console.app (filter by
// subsystem "audio.oto.app"). Values are marked .public so they actually show
// while developing — never log full tokens, only their presence/length.
enum Log {
    static let auth = Logger(subsystem: "audio.oto.app", category: "auth")
    static let api = Logger(subsystem: "audio.oto.app", category: "api")
}
