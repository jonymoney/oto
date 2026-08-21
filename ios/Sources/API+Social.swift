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

    struct TagCount: Decodable, Hashable {
        let tag: String
        let count: Int
    }

    struct ExplorePayload: Decodable {
        let follows: [AudioItem]
        let forYou: [AudioItem]
        let tags: [TagCount]
        let recent: [AudioItem]

        private enum CodingKeys: String, CodingKey { case follows, forYou, tags, recent, items }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            follows = try c.decodeIfPresent([AudioItem].self, forKey: .follows) ?? []
            forYou = try c.decodeIfPresent([AudioItem].self, forKey: .forYou) ?? []
            tags = try c.decodeIfPresent([TagCount].self, forKey: .tags) ?? []
            // Server sends both `recent` and its alias `items`; prefer `recent`.
            recent = try c.decodeIfPresent([AudioItem].self, forKey: .recent)
                ?? c.decodeIfPresent([AudioItem].self, forKey: .items) ?? []
        }
    }

    static func explore() async throws -> ExplorePayload {
        let (data, _) = try await send(request("api/explore"))
        return try JSONDecoder().decode(ExplorePayload.self, from: data)
    }

    static func tagAudios(tag: String) async throws -> [AudioItem] {
        // Path segment: also encode "/" so a slash in a tag can't split the path.
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encoded = tag.addingPercentEncoding(withAllowedCharacters: allowed) ?? tag
        let (data, _) = try await send(request("api/tags/\(encoded)/audios"))
        return try JSONDecoder().decode(AudioItems.self, from: data).items
    }

    static func saveAudio(id: String) async throws {
        _ = try await send(request("api/audios/\(id)/save", method: "POST"))
    }
    // Unsave lives in API+Collections.swift as removeSavedAudio(id:).
}
