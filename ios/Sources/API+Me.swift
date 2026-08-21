import Foundation

// Profile, account deletion, and billing-portal endpoints.
extension API {
    struct Me: Decodable {
        let email: String
        var username: String?   // var: local UI patches these after edits
        var avatarUrl: String?
    }

    static func me() async throws -> Me {
        let (data, _) = try await send(request("api/me"))
        return try JSONDecoder().decode(Me.self, from: data)
    }

    /// 400 {error:'invalid'|'reserved'} / 409 {error:'taken'} arrive as
    /// APIError.server carrying that string (send() maps non-2xx bodies).
    static func updateUsername(_ username: String) async throws -> Me {
        var req = request("api/me", method: "PUT")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["username": username])
        let (data, _) = try await send(req)
        return try JSONDecoder().decode(Me.self, from: data)
    }

    static func usernameAvailable(_ username: String) async throws -> (available: Bool, reason: String?) {
        struct Availability: Decodable { let available: Bool; let reason: String? }
        var req = request("api/me/username-available")
        if let u = req.url, var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "u", value: username)]
            req.url = comps.url
        }
        let (data, _) = try await send(req)
        let a = try JSONDecoder().decode(Availability.self, from: data)
        return (a.available, a.reason)
    }

    /// Uploads a square JPEG; returns the new avatarUrl.
    static func uploadAvatar(jpeg: Data) async throws -> String {
        struct AvatarResponse: Decodable { let avatarUrl: String }
        var req = request("api/me/avatar", method: "PUT")
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        req.httpBody = jpeg
        let (data, _) = try await send(req)
        return try JSONDecoder().decode(AvatarResponse.self, from: data).avatarUrl
    }

    /// Deletes the account (and revokes the session) server-side. Any 2xx is
    /// success; the caller only needs local teardown afterwards.
    static func deleteAccount() async throws {
        var req = request("api/auth/delete-user", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        _ = try await send(req)
    }

    /// Stripe customer-portal URL for managing the subscription.
    static func billingPortal() async throws -> URL {
        struct PortalURL: Decodable { let url: String }
        let (data, _) = try await send(request("api/billing/portal", method: "POST"))
        guard let url = URL(string: try JSONDecoder().decode(PortalURL.self, from: data).url) else {
            throw APIError.badResponse
        }
        return url
    }
}
