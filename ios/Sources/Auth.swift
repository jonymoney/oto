import Foundation
import Observation

@MainActor
@Observable
final class AuthManager {
    enum Phase: Equatable {
        case signedOut
        case awaitingLink(email: String) // link sent, waiting for the deep link
        case signedIn
    }

    private(set) var phase: Phase = TokenStore.token != nil ? .signedIn : .signedOut
    var errorMessage: String?

    var isSignedIn: Bool { phase == .signedIn }

    func sendMagicLink(email: String) async {
        errorMessage = nil
        do {
            try await API.sendMagicLink(email: email)
            phase = .awaitingLink(email: email)
        } catch {
            errorMessage = "Couldn't send the sign-in link. Check the email and try again."
        }
    }

    /// Handles otoaudio://auth-callback?token=… from the web handoff page.
    func handleDeepLink(_ url: URL) async {
        guard url.scheme == "otoaudio",
              let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else { return }
        do {
            let session = try await API.verifyMagicLink(token: token)
            TokenStore.token = session
            phase = .signedIn
        } catch {
            errorMessage = "That sign-in link didn't work. Request a new one."
            phase = .signedOut
        }
    }

    func signOut() async {
        await API.signOut()
        TokenStore.token = nil
        phase = .signedOut
    }

    /// Called when any authed request returns 401 — the session is gone.
    func sessionExpired() {
        TokenStore.token = nil
        phase = .signedOut
    }
}
