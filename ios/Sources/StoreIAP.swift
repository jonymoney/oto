import StoreKit

/// Apple In-App Purchase rail — the paywall's purchase path on non-US
/// storefronts (the US uses the Stripe web checkout, commission-free).
/// The signed transaction is reported to the server, which verifies the JWS
/// itself and flips the same `unlimited` flag Stripe uses.
@MainActor
@Observable
final class StoreIAP {
    /// Must match App Store Connect and the server's APPLE_PRODUCT_ID.
    static let productID = "audio.oto.app.unlimited.monthly"

    private(set) var product: Product?
    private(set) var purchasing = false

    /// nil until ASC has the product live (or offline) — the paywall shows
    /// the purchase button only when a product loaded.
    func load() async {
        guard product == nil else { return }
        product = try? await Product.products(for: [Self.productID]).first
    }

    /// True when the subscription ended up active AND the server knows.
    func purchase() async -> Bool {
        guard let product, !purchasing else { return false }
        purchasing = true
        defer { purchasing = false }
        guard let result = try? await product.purchase() else { return false }
        switch result {
        case .success(let verification):
            return await sync(verification)
        case .pending, .userCancelled:
            return false
        @unknown default:
            return false
        }
    }

    /// Reinstall/second-device recovery: re-sync the current entitlement.
    func restore() async -> Bool {
        for await entitlement in Transaction.currentEntitlements {
            if case .verified(let tx) = entitlement, tx.productID == Self.productID {
                return await sync(entitlement)
            }
        }
        return false
    }

    private func sync(_ verification: VerificationResult<Transaction>) async -> Bool {
        // The server re-verifies the JWS against Apple's roots — local
        // verification is not the gate.
        let synced = (try? await API.appleSync(jws: verification.jwsRepresentation)) ?? false
        // ponytail: finish unconditionally — if the server sync failed
        // (offline), Restore Purchases is the recovery path; a
        // Transaction.updates listener is the upgrade if that ever bites.
        if case .verified(let tx) = verification { await tx.finish() }
        return synced
    }
}
