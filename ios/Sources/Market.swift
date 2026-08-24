import StoreKit

/// External purchase links (our Stripe web checkout) are only permitted on the
/// US App Store storefront — everywhere else the upgrade UI must not exist.
/// Keyed off the App Store account's storefront, NOT locale or geolocation:
/// that's the signal Apple's rule is tied to.
@MainActor
enum Market {
    private static var cached: Bool?

    static func isUS() async -> Bool {
        if let cached { return cached }
        #if targetEnvironment(simulator)
        // Simulators rarely have an App Store account, which would read as
        // non-US and hide the paywall from every dev build.
        let us = true
        #else
        let us = await Storefront.current?.countryCode == "USA"
        #endif
        cached = us
        return us
    }
}
