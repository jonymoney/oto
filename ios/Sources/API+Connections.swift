import Foundation

// Connected AI clients (OAuth'd MCP clients): list + revoke.
extension API {
    struct Connection: Decodable, Hashable {
        let clientId: String
        let name: String
        let firstConnectedAt: String
        let lastUsedAt: String?
    }

    private struct ConnectionItems: Decodable { let items: [Connection] }

    static func connections() async throws -> [Connection] {
        let (data, _) = try await send(request("api/connections"))
        return try JSONDecoder().decode(ConnectionItems.self, from: data).items
    }

    static func disconnect(clientId: String) async throws {
        _ = try await send(request("api/connections/\(clientId)", method: "DELETE"))
    }
}
