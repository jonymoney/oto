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
        Log.auth.notice("sending magic link to \(email, privacy: .public)")
        do {
            try await API.sendMagicLink(email: email)
            phase = .awaitingLink(email: email)
            Log.auth.notice("magic link sent — awaiting deep link")
        } catch {
            Log.auth.error("sendMagicLink failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = "Couldn't send the sign-in link. Check the email and try again."
        }
    }

    /// Handles otoaudio://auth-callback?token=… from the web handoff page.
    func handleDeepLink(_ url: URL) async {
        Log.auth.notice("deep link received: \(url.scheme ?? "?", privacy: .public)://\(url.host ?? "?", privacy: .public)")
        guard url.scheme == "otoaudio",
              let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else {
            Log.auth.error("deep link ignored — wrong scheme or no token")
            return
        }
        Log.auth.notice("verifying magic-link token (\(token.count, privacy: .public) chars)")
        do {
            let session = try await API.verifyMagicLink(token: token)
            TokenStore.token = session
            phase = .signedIn
            Log.auth.notice("signed in — session stored (\(session.count, privacy: .public) chars)")
        } catch {
            Log.auth.error("verify failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = "That sign-in link didn't work. Request a new one."
            phase = .signedOut
        }
    }

    func signOut() async {
        Log.auth.notice("signing out")
        await API.signOut()
        TokenStore.token = nil
        phase = .signedOut
    }

    /// Called when any authed request returns 401 — the session is gone.
    func sessionExpired() {
        Log.auth.notice("session expired — clearing token")
        TokenStore.token = nil
        phase = .signedOut
    }
}
