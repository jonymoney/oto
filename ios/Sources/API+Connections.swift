import Foundation

// Connected AI clients (OAuth'd MCP clients): list + revoke.
extension API {
    struct Connection: Decodable, Hashable {
        let clientId: String
        /// One row can cover several OAuth registrations of the same AI
        /// (Claude registers a fresh client per connection) — server groups
        /// them by display name.
        let clientIds: [String]
        let name: String
        let firstConnectedAt: String
        let lastUsedAt: String?

        private enum CodingKeys: String, CodingKey {
            case clientId, clientIds, name, firstConnectedAt, lastUsedAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            clientId = try c.decode(String.self, forKey: .clientId)
            clientIds = try c.decodeIfPresent([String].self, forKey: .clientIds) ?? [clientId]
            name = try c.decode(String.self, forKey: .name)
            firstConnectedAt = try c.decode(String.self, forKey: .firstConnectedAt)
            lastUsedAt = try c.decodeIfPresent(String.self, forKey: .lastUsedAt)
        }
    }

    private struct ConnectionItems: Decodable { let items: [Connection] }

    static func connections() async throws -> [Connection] {
        let (data, _) = try await send(request("api/connections"))
        return try JSONDecoder().decode(ConnectionItems.self, from: data).items
    }

    static func disconnect(_ connection: Connection) async throws {
        for id in connection.clientIds {
            _ = try await send(request("api/connections/\(id)", method: "DELETE"))
        }
    }
}
