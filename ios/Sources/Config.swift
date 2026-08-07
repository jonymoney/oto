import Foundation

enum Config {
    // Points at production. For local server dev, swap to http://localhost:3001
    // (the Info.plist keeps an ATS exception for localhost).
    static let baseURL = URL(string: "https://oto.audio")!
}
