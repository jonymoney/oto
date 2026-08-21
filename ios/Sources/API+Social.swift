import Foundation

// Social endpoints: people search, profiles, follow graph, explore feed, saves.
extension API {
    struct UserSummary: Decodable, Hashable {
        let username: String
        let avatarUrl: String?
    }

    struct UserProfile: Decodable {
        struct Counts: Decodable {
            let audios: Int
            let followers: Int
            let following: Int
        }
        let username: String
        let avatarUrl: String?
        let counts: Counts
        let youFollow: Bool
        let followsYou: Bool
    }

    private struct UserItems: Decodable { let items: [UserSummary] }
    // Not AudioList: these endpoints return { items } without a total.
    private struct AudioItems: Decodable { let items: [AudioItem] }

    static func searchUsers(q: String) async throws -> [UserSummary] {
        var req = request("api/users/search")
        // appendingPathComponent would percent-encode "?", so add the query here.
        if let u = req.url, var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "q", value: q)]
            req.url = comps.url
        }
        let (data, _) = try await send(req)
        return try JSONDecoder().decode(UserItems.self, from: data).items
    }

    static func userProfile(username: String) async throws -> UserProfile {
        let (data, _) = try await send(request("api/users/\(username)"))
        return try JSONDecoder().decode(UserProfile.self, from: data)
    }

    static func follow(username: String) async throws {
        _ = try await send(request("api/users/\(username)/follow", method: "PUT"))
    }

    static func unfollow(username: String) async throws {
        _ = try await send(request("api/users/\(username)/follow", method: "DELETE"))
    }

    static func following() async throws -> [UserSummary] {
        let (data, _) = try await send(request("api/following"))
        return try JSONDecoder().decode(UserItems.self, from: data).items
    }

    static func userAudios(username: String) async throws -> [AudioItem] {
        let (data, _) = try await send(request("api/users/\(username)/audios"))
        return try JSONDecoder().decode(AudioItems.self, from: data).items
    }

    static func explore() async throws -> [AudioItem] {
        let (data, _) = try await send(request("api/explore"))
        return try JSONDecoder().decode(AudioItems.self, from: data).items
    }

    static func saveAudio(id: String) async throws {
        _ = try await send(request("api/audios/\(id)/save", method: "POST"))
    }
    // Unsave lives in API+Collections.swift as removeSavedAudio(id:).
}
