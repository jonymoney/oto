import Foundation
import Observation

@MainActor
@Observable
final class AuthManager {
    enum Phase: Equatable {
        case signedOut
        case enteringCode(email: String) // code emailed, waiting for the user to type it
        case signedIn
    }

    private(set) var phase: Phase = TokenStore.token != nil ? .signedIn : .signedOut
    var errorMessage: String?

    var isSignedIn: Bool { phase == .signedIn }

    func sendCode(email: String) async {
        errorMessage = nil
        Log.auth.notice("sending OTP to \(email, privacy: .public)")
        do {
            try await API.sendEmailOTP(email: email)
            phase = .enteringCode(email: email)
            Log.auth.notice("OTP sent — awaiting code")
        } catch {
            Log.auth.error("sendCode failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = "Couldn't send the code. Check the email and try again."
        }
    }

    func verifyCode(_ otp: String) async {
        guard case let .enteringCode(email) = phase else { return }
        errorMessage = nil
        Log.auth.notice("verifying OTP (\(otp.count, privacy: .public) digits)")
        do {
            let session = try await API.signInWithOTP(email: email, otp: otp)
            TokenStore.token = session
            phase = .signedIn
            Log.auth.notice("signed in — session stored (\(session.count, privacy: .public) chars)")
        } catch {
            Log.auth.error("verify failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = "That code didn't work. Check it or request a new one."
        }
    }

    func restart() {
        phase = .signedOut
        errorMessage = nil
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
