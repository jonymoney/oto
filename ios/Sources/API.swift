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
    let shareUrl: String?
    let positionSec: Double?
    let playedAt: String?
    // Social: owner username (nil = own audio) and visibility (own audios only).
    let owner: String?
    let visibility: String?
    // MCP client that generated the audio (e.g. "Claude"), when known.
    let clientName: String?
    // Creator's cover style ("classic"/"ink"/"halftone"/"tessellation") — covers always render
    // in the CREATOR's style, so this rides along with every audio payload.
    let coverStyle: String

    enum CodingKeys: String, CodingKey {
        case id, title, durationSec, voice, charCount, createdAt, status, summary, emoji, language, mood, tags, shareUrl, positionSec, playedAt, owner, visibility, clientName, coverStyle
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
        shareUrl = try c.decodeIfPresent(String.self, forKey: .shareUrl)
        positionSec = try c.decodeIfPresent(Double.self, forKey: .positionSec)
        playedAt = try c.decodeIfPresent(String.self, forKey: .playedAt)
        owner = try c.decodeIfPresent(String.self, forKey: .owner)
        visibility = try c.decodeIfPresent(String.self, forKey: .visibility)
        clientName = try c.decodeIfPresent(String.self, forKey: .clientName)
        // Default keeps the app working against servers that predate coverStyle.
        coverStyle = try c.decodeIfPresent(String.self, forKey: .coverStyle) ?? "classic"
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
    let shareUrl: String?
    let positionSec: Double?
    let playedAt: String?
    let owner: String?
    let visibility: String?
    let clientName: String?
    let coverStyle: String

    enum CodingKeys: String, CodingKey {
        case id, title, durationSec, voice, createdAt, status, audioUrl, summary, emoji, language, mood, tags, shareUrl, positionSec, playedAt, owner, visibility, clientName, coverStyle
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
        shareUrl = try c.decodeIfPresent(String.self, forKey: .shareUrl)
        positionSec = try c.decodeIfPresent(Double.self, forKey: .positionSec)
        playedAt = try c.decodeIfPresent(String.self, forKey: .playedAt)
        owner = try c.decodeIfPresent(String.self, forKey: .owner)
        visibility = try c.decodeIfPresent(String.self, forKey: .visibility)
        clientName = try c.decodeIfPresent(String.self, forKey: .clientName)
        coverStyle = try c.decodeIfPresent(String.self, forKey: .coverStyle) ?? "classic"
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

    // Internal (not private) so API+*.swift extension files can build requests.
    static func request(_ path: String, method: String = "GET", auth: Bool = true) -> URLRequest {
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

    static func send(_ req: URLRequest, followRedirects: Bool = true) async throws -> (Data, HTTPURLResponse) {
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

    /// Email of the signed-in user, from Better Auth's get-session. Throws if
    /// the session is dead (body is `null` → decode fails).
    static func sessionEmail() async throws -> String {
        struct SessionResponse: Decodable {
            struct User: Decodable { let email: String }
            let user: User
        }
        let (data, _) = try await send(request("api/auth/get-session"))
        return try JSONDecoder().decode(SessionResponse.self, from: data).user.email
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

    /// Continue Listening: best-effort position report — failures are silent
    /// (the local ResumeStore mirror keeps resume working offline).
    static func reportPosition(id: String, positionSec: Double) {
        Task {
            var req = request("api/audios/\(id)/position", method: "PUT")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONEncoder().encode(["positionSec": positionSec])
            _ = try? await send(req)
        }
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
        let showUpgrade: Bool?
    }

    static func usage() async throws -> Usage {
        let (data, _) = try await send(request("api/usage"))
        return try JSONDecoder().decode(Usage.self, from: data)
    }

    // MARK: Prefs

    /// nil voice = server default. Each voice carries its provider (openai/fish);
    /// fish voices only appear when the server has the key configured.
    struct Voice: Decodable, Hashable {
        let name: String
        let provider: String
    }

    struct Prefs: Decodable {
        let voice: String?
        let language: String?
        let voices: [Voice]
        let languages: [String]
    }

    static func prefs() async throws -> Prefs {
        let (data, _) = try await send(request("api/prefs"))
        return try JSONDecoder().decode(Prefs.self, from: data)
    }

    /// Partial update — only the fields passed change on the server.
    static func updatePrefs(voice: String? = nil, language: String? = nil) async throws -> Prefs {
        var req = request("api/prefs", method: "PUT")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = [:]
        if let voice { body["voice"] = voice }
        if let language { body["language"] = language }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await send(req)
        return try JSONDecoder().decode(Prefs.self, from: data)
    }

    private struct PreviewURL: Decodable { let url: String }

    /// URL of the short sample where the voice introduces itself. Samples are
    /// cached in Caches/previews on first play, so replays are local and offline.
    static func voicePreviewURL(voice: String, provider: String?, language: String?) async throws -> URL {
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("previews/\(provider ?? "default")/\(language ?? "default")", isDirectory: true)
        let local = cacheDir.appendingPathComponent("\(voice).mp3")
        if FileManager.default.fileExists(atPath: local.path) { return local }
        var req = request("api/voices/\(voice)/preview")
        // appendingPathComponent would percent-encode "?", so add the query here.
        if let u = req.url, var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
            var items: [URLQueryItem] = []
            if let provider { items.append(URLQueryItem(name: "provider", value: provider)) }
            if let language { items.append(URLQueryItem(name: "lang", value: language)) }
            if !items.isEmpty { comps.queryItems = items }
            req.url = comps.url
        }
        let (data, _) = try await send(req)
        guard let url = URL(string: try JSONDecoder().decode(PreviewURL.self, from: data).url) else {
            throw APIError.badResponse
        }
        let (audio, _) = try await URLSession.shared.data(from: url)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        try audio.write(to: local)
        return local
    }

    // MARK: Billing

    private struct CheckoutURL: Decodable { let url: String }

    /// Starts a Stripe Checkout for the signed-in user and returns the hosted
    /// URL to open. Throws if billing is unconfigured (501) — caller falls back
    /// to the web /upgrade page.
    static func checkout() async throws -> URL {
        let (data, _) = try await send(request("api/billing/checkout", method: "POST"))
        let str = try JSONDecoder().decode(CheckoutURL.self, from: data).url
        guard let url = URL(string: str) else { throw APIError.badResponse }
        return url
    }
}
