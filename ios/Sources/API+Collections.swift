import Foundation

// Collections + audio visibility endpoints.
extension API {
    struct Collection: Decodable, Identifiable {
        let id: String
        let name: String
        let count: Int
    }

    struct CollectionDetail: Decodable {
        let id: String
        let name: String
        let items: [AudioItem]
    }

    private struct CollectionList: Decodable { let items: [Collection] }

    static func collections() async throws -> [Collection] {
        let (data, _) = try await send(request("api/collections"))
        return try JSONDecoder().decode(CollectionList.self, from: data).items
    }

    static func createCollection(name: String) async throws -> Collection {
        var req = request("api/collections", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["name": name])
        let (data, _) = try await send(req)
        return try JSONDecoder().decode(Collection.self, from: data)
    }

    static func deleteCollection(id: String) async throws {
        _ = try await send(request("api/collections/\(id)", method: "DELETE"))
    }

    static func addToCollection(id: String, audioId: String) async throws {
        _ = try await send(request("api/collections/\(id)/items/\(audioId)", method: "PUT"))
    }

    static func removeFromCollection(id: String, audioId: String) async throws {
        _ = try await send(request("api/collections/\(id)/items/\(audioId)", method: "DELETE"))
    }

    static func collection(id: String) async throws -> CollectionDetail {
        let (data, _) = try await send(request("api/collections/\(id)"))
        return try JSONDecoder().decode(CollectionDetail.self, from: data)
    }

    /// visibility: private | followers | friends | public (own audios only).
    static func setVisibility(audioId: String, _ visibility: String) async throws {
        var req = request("api/audios/\(audioId)", method: "PATCH")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["visibility": visibility])
        _ = try await send(req)
    }

    /// Permanently deletes one of the caller's own audios (server also removes
    /// it for anyone who saved it).
    static func deleteAudio(id: String) async throws {
        _ = try await send(request("api/audios/\(id)", method: "DELETE"))
    }

    /// Removes someone else's saved audio from the library.
    /// ponytail: named removeSavedAudio (not unsaveAudio) to avoid colliding
    /// with the save/unsave pair in API+Social.swift.
    static func removeSavedAudio(id: String) async throws {
        _ = try await send(request("api/audios/\(id)/save", method: "DELETE"))
    }
}
