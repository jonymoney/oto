import Foundation

struct AudioItem: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let durationSec: Double?
    let voice: String
    let charCount: Int
    let createdAt: String
    let status: String
    let summary: String?
    let emoji: String?
    let language: String?
    let mood: String?
    let tags: [String]

    enum CodingKeys: String, CodingKey {
        case id, title, durationSec, voice, charCount, createdAt, status, summary, emoji, language, mood, tags
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        durationSec = try c.decodeIfPresent(Double.self, forKey: .durationSec)
        voice = try c.decode(String.self, forKey: .voice)
        charCount = try c.decode(Int.self, forKey: .charCount)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        status = try c.decode(String.self, forKey: .status)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        mood = try c.decodeIfPresent(String.self, forKey: .mood)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
    }
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
    let summary: String?
    let emoji: String?
    let language: String?
    let mood: String?
    let tags: [String]

    enum CodingKeys: String, CodingKey {
        case id, title, durationSec, voice, createdAt, status, audioUrl, summary, emoji, language, mood, tags
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        durationSec = try c.decodeIfPresent(Double.self, forKey: .durationSec)
        voice = try c.decode(String.self, forKey: .voice)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        status = try c.decode(String.self, forKey: .status)
        audioUrl = try c.decodeIfPresent(String.self, forKey: .audioUrl)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        mood = try c.decodeIfPresent(String.self, forKey: .mood)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
    }
}

enum APIError: Error {
    case unauthorized          // 401 outside /api/auth → session is dead
    case server(String)        // 4xx/5xx: carries the server's own error message
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

    // Better Auth errors come back as JSON like {"message":"..."} / {"error":"..."}.
    private static func serverMessage(from data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let m = obj["message"] as? String, !m.isEmpty { return m }
        if let e = obj["error"] as? String, !e.isEmpty { return e }
        return nil
    }

    private static func request(_ path: String, method: String = "GET", auth: Bool = true) -> URLRequest {
        var req = URLRequest(url: Config.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        // Better Auth rejects Origin-less POSTs (CSRF guard). Native URLSession
        // sends none, so set our own origin — it's in the server's trustedOrigins.
        req.setValue(Config.baseURL.absoluteString, forHTTPHeaderField: "Origin")
        let hasToken = auth && TokenStore.token != nil
        if hasToken, let token = TokenStore.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        Log.api.debug("→ \(method, privacy: .public) /\(path, privacy: .public) (bearer: \(hasToken, privacy: .public))")
        return req
    }

    private static func send(_ req: URLRequest, followRedirects: Bool = true) async throws -> (Data, HTTPURLResponse) {
        let path = req.url?.path ?? "?"
        do {
            let (data, resp): (Data, URLResponse)
            if followRedirects {
                (data, resp) = try await URLSession.shared.data(for: req)
            } else {
                (data, resp) = try await URLSession.shared.data(for: req, delegate: noRedirect)
            }
            guard let http = resp as? HTTPURLResponse else {
                Log.api.error("✗ \(path, privacy: .public): non-HTTP response")
                throw APIError.badResponse
            }
            Log.api.debug("← \(http.statusCode, privacy: .public) \(path, privacy: .public) (\(data.count, privacy: .public) bytes)")
            let isAuthPath = req.url?.path.hasPrefix("/api/auth") ?? false
            if http.statusCode == 401 && !isAuthPath {
                Log.api.notice("✗ 401 on \(path, privacy: .public) — session expired")
                throw APIError.unauthorized
            }
            guard (200..<400).contains(http.statusCode) else {
                Log.api.error("✗ \(http.statusCode, privacy: .public) on \(path, privacy: .public): \(String(decoding: data, as: UTF8.self), privacy: .public)")
                throw APIError.server(serverMessage(from: data) ?? "Something went wrong (\(http.statusCode)).")
            }
            return (data, http)
        } catch let error where !(error is APIError) {
            // Transport failures (offline, TLS, host unreachable) — the most
            // common "nothing happens" cause when pointing at prod.
            Log.api.error("✗ \(path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    // MARK: Auth

    static func sendEmailOTP(email: String) async throws {
        var req = request("api/auth/email-otp/send-verification-otp", method: "POST", auth: false)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email, "type": "sign-in"])
        _ = try await send(req)
    }

    /// Verifies the 6-digit code and returns the session bearer. This is a plain
    /// 200 JSON response (no redirect), so set-auth-token arrives cleanly.
    static func signInWithOTP(email: String, otp: String) async throws -> String {
        var req = request("api/auth/sign-in/email-otp", method: "POST", auth: false)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email, "otp": otp])
        let (data, http) = try await send(req)
        if let t = http.value(forHTTPHeaderField: "set-auth-token"), !t.isEmpty { return t }
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

    // MARK: Usage

    struct Usage: Decodable {
        let generatedSec: Double
        let quotaSec: Double
        let unlimited: Bool
    }

    static func usage() async throws -> Usage {
        let (data, _) = try await send(request("api/usage"))
        return try JSONDecoder().decode(Usage.self, from: data)
    }
}
