import Foundation
import Observation

@MainActor
@Observable
final class AuthManager {
    /// Login method. Email is the only functional one today; Phone is wired for
    /// the UI (segmented control) but the backend has no phone plugin yet — see
    /// `sendCode`/`resendCode`, which only ever call the email endpoints.
    enum Method: String, CaseIterable, Identifiable {
        case email, phone
        var id: String { rawValue }
    }

    /// The spec's state machine (idle | loading | codeSent | signedIn | error)
    /// maps onto three orthogonal fields, because "loading" and "error" each need
    /// to remember which screen they overlay:
    ///   phase       → which screen (idle form / code entry / main app)
    ///   isWorking   → the "loading" overlay (spinner, disabled fields)
    ///   errorMessage → the "error" alert (nil = none)
    enum Phase: Equatable { case idle, codeSent, signedIn }

    private(set) var phase: Phase = TokenStore.token != nil ? .signedIn : .idle
    var method: Method = .email
    var isWorking = false
    var errorMessage: String?          // drives the alert; restoring the form is automatic
    private(set) var destination = ""  // email the code was sent to (cached between send + verify)

    var isSignedIn: Bool { phase == .signedIn }

    // MARK: Email OTP

    func sendCode(email raw: String) async {
        let email = raw.trimmingCharacters(in: .whitespaces)
        guard email.contains("@") else { return }   // empty/invalid ignored silently
        Log.auth.notice("sending OTP to \(email, privacy: .public)")
        isWorking = true; defer { isWorking = false }
        do {
            try await API.sendEmailOTP(email: email)
            destination = email
            phase = .codeSent
            Log.auth.notice("OTP sent — awaiting code")
        } catch {
            errorMessage = message(for: error)       // phase stays .idle
        }
    }

    func resendCode() async {
        guard phase == .codeSent, method == .email, !destination.isEmpty else { return }
        Log.auth.notice("resending OTP to \(self.destination, privacy: .public)")
        isWorking = true; defer { isWorking = false }
        do {
            try await API.sendEmailOTP(email: destination)
        } catch {
            errorMessage = message(for: error)
        }
    }

    func verifyCode(_ raw: String) async {
        guard phase == .codeSent else { return }
        let otp = raw.trimmingCharacters(in: .whitespaces)
        guard !otp.isEmpty else { return }
        Log.auth.notice("verifying OTP (\(otp.count, privacy: .public) digits)")
        isWorking = true; defer { isWorking = false }
        do {
            let token = try await API.signInWithOTP(email: destination, otp: otp)
            TokenStore.token = token
            phase = .signedIn                        // → main app
            Log.auth.notice("signed in — session stored (\(token.count, privacy: .public) chars)")
        } catch {
            errorMessage = message(for: error)       // phase stays .codeSent
        }
    }

    /// Back to the initial form so a mistyped destination can be corrected.
    func changeDestination() {
        destination = ""
        errorMessage = nil
        phase = .idle
    }

    // MARK: Session lifecycle

    /// Explicit sign-out: best-effort server revoke, then wipe everything local.
    /// Never surfaces a failure to the user.
    func logout() async {
        Log.auth.notice("signing out")
        await API.signOut()          // best-effort; ignore failure
        clearSession()
    }

    /// Called when an authed request to a non-auth route returns 401 — the
    /// session is dead. Same teardown as logout, minus the server round-trip.
    func sessionExpired() {
        Log.auth.notice("session expired — clearing token")
        clearSession()
    }

    private func clearSession() {
        wipeLocalData()
        TokenStore.token = nil
        destination = ""
        errorMessage = nil
        phase = .idle
    }

    /// THE place to add future local-data wipes (push token, local DB, image
    /// cache). Called on both logout and session expiry.
    private func wipeLocalData() {
        // ponytail: nothing local to wipe yet — future caches hook in here.
    }

    private func message(for error: Error) -> String {
        if case let APIError.server(m) = error { return m }
        return error.localizedDescription
    }
}
