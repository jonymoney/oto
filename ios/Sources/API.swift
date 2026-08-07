import Foundation

struct AudioItem: Identifiable, Decodable, Hashable {
    let id: String
    let title: String
    let durationSec: Double?
    let voice: String
    let charCount: Int
    let createdAt: String
    let status: String
}

struct AudioList: Decodable {
    let items: [AudioItem]
    let total: Int
}

struct AudioDetail: Decodable {
    let id: String
    let title: String
    let durationSec: Double?
    let voice: String
    let createdAt: String
    let status: String
    let audioUrl: String?
}

enum APIError: Error {
    case unauthorized          // 401 outside /api/auth → session is dead
    case http(Int)
    case badResponse
}

// Thin URLSession client. Reads the bearer from the Keychain per request; a 401
// on a non-auth path surfaces as .unauthorized so the caller can sign out.
enum API {
    // Don't auto-follow redirects: Better Auth's magic-link/verify may 302 to a
    // callback; we want the JSON body + set-auth-token header instead.
    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ s: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection r: HTTPURLResponse, newRequest: URLRequest) async -> URLRequest? { nil }
    }
    private static let noRedirect = NoRedirect()

    private static func request(_ path: String, method: String = "GET", auth: Bool = true) -> URLRequest {
        var req = URLRequest(url: Config.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        if auth, let token = TokenStore.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private static func send(_ req: URLRequest, followRedirects: Bool = true) async throws -> (Data, HTTPURLResponse) {
        let (data, resp): (Data, URLResponse)
        if followRedirects {
            (data, resp) = try await URLSession.shared.data(for: req)
        } else {
            (data, resp) = try await URLSession.shared.data(for: req, delegate: noRedirect)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse }
        let isAuthPath = req.url?.path.hasPrefix("/api/auth") ?? false
        if http.statusCode == 401 && !isAuthPath { throw APIError.unauthorized }
        guard (200..<400).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
        return (data, http)
    }

    // MARK: Auth

    static func sendMagicLink(email: String) async throws {
        var req = request("api/auth/sign-in/magic-link", method: "POST", auth: false)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email])
        _ = try await send(req)
    }

    /// Exchanges the single-use magic-link token for a session bearer.
    static func verifyMagicLink(token: String) async throws -> String {
        let req = request("api/auth/magic-link/verify?token=\(token)", auth: false)
        let (data, http) = try await send(req, followRedirects: false)
        // Better Auth's bearer plugin returns the session token in this header.
        if let t = http.value(forHTTPHeaderField: "set-auth-token"), !t.isEmpty { return t }
        // Fallback: some responses carry it in the JSON body as `token`.
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let t = obj["token"] as? String, !t.isEmpty { return t }
        throw APIError.badResponse
    }

    static func signOut() async {
        var req = request("api/auth/sign-out", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await send(req) // best-effort server-side revoke
    }

    // MARK: Audios

    static func listAudios() async throws -> [AudioItem] {
        let (data, _) = try await send(request("api/audios"))
        return try JSONDecoder().decode(AudioList.self, from: data).items
    }

    static func audioDetail(id: String) async throws -> AudioDetail {
        let (data, _) = try await send(request("api/audios/\(id)"))
        return try JSONDecoder().decode(AudioDetail.self, from: data)
    }

    struct FreshURL: Decodable { let audioUrl: String }
    static func freshURL(id: String) async throws -> String {
        let (data, _) = try await send(request("api/audios/\(id)/url"))
        return try JSONDecoder().decode(FreshURL.self, from: data).audioUrl
    }
}
