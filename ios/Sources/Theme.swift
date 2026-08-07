import SwiftUI

/// oto brand palette. Code-only dynamic colors (no asset catalog) so it fits
/// the XcodeGen setup. Each token adapts to light/dark via UITraitCollection.
enum Theme {
    static let bg      = dynamic(light: 0xf6f4ee, dark: 0x23211e)
    static let surface = dynamic(light: 0xfffdf8, dark: 0x2b2926)
    static let ink     = dynamic(light: 0x211e19, dark: 0xece8df)
    static let ink2    = dynamic(light: 0x6e6759, dark: 0xa39c8e)
    static let ink3    = dynamic(light: 0x9a9181, dark: 0x756f63)
    static let line    = dynamic(light: 0xe0dbce, dark: 0x3a3733)
    static let accent  = dynamic(light: 0xe08600, dark: 0xffb02e)
    static let danger  = dynamic(light: 0xc2402a, dark: 0xff8a70)

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(uiColor: UIColor { trait in
            uiColor(trait.userInterfaceStyle == .dark ? dark : light)
        })
    }

    private static func uiColor(_ hex: Int) -> UIColor {
        UIColor(
            red:   CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue:  CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }
}
