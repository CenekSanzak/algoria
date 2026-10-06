import AppKit
import CoreText

// Brand tokens from landing/src/app.css. Fonts are process-local, bundled and
// never downloaded (or installed on the user's system) during wallet approval.
enum WalletDesign {
    static func adaptive(_ name: String, dark: String, light: String) -> NSColor {
        NSColor(name: name) { appearance in
            color(appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light)
        }
    }
    static func color(_ hex: String) -> NSColor {
        let value = UInt32(hex, radix: 16)!
        return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
                       green: CGFloat((value >> 8) & 255) / 255,
                       blue: CGFloat(value & 255) / 255, alpha: 1)
    }
    static let background = adaptive("Algoria background", dark: "04060a", light: "dee2ea")
    static let surface = adaptive("Algoria surface", dark: "12161f", light: "eceef2")
    static let elevated = adaptive("Algoria elevated", dark: "181d28", light: "fafbfc")
    static let text = adaptive("Algoria text", dark: "eef1f6", light: "0c1016")
    static let secondary = adaptive("Algoria secondary", dark: "c6ccd6", light: "454c58")
    // Slightly brighter than the web muted token for small approval-window copy.
    static let muted = adaptive("Algoria muted", dark: "9aa3b1", light: "555e6c")
    static let accent = adaptive("Algoria silver", dark: "b8bfc9", light: "57616e")
    static let success = adaptive("Algoria online", dark: "8da89a", light: "456a55")
    static let warning = adaptive("Algoria warning", dark: "d6b785", light: "785a28")
    static let danger = adaptive("Algoria danger", dark: "e6a3a3", light: "a02f3a")
    static var border: NSColor {
        accent.withAlphaComponent(NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 0.55 : 0.18)
    }
    static let registeredFonts: Void = {
        for name in ["Prompt-Regular", "Prompt-Medium", "Prompt-SemiBold", "GeistMono"] {
            if let url = Bundle.main.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }()
    static func font(size: CGFloat, weight: NSFont.Weight = .regular, mono: Bool = false) -> NSFont {
        _ = registeredFonts
        let name = mono ? "GeistMono-Regular" : weight.rawValue >= NSFont.Weight.semibold.rawValue
            ? "Prompt-SemiBold" : weight.rawValue >= NSFont.Weight.medium.rawValue ? "Prompt-Medium" : "Prompt-Regular"
        return NSFont(name: name, size: size) ?? (mono
            ? .monospacedSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight))
    }
    static func drawLogo(in rect: NSRect) {
        // Exact 64 × 64 geometry and colors of static/favicon.svg, not a new mark.
        NSGraphicsContext.saveGraphicsState()
        let transform = NSAffineTransform()
        transform.translateX(by: rect.minX, yBy: rect.minY)
        transform.concat()
        let scale = NSAffineTransform()
        scale.scaleX(by: rect.width / 64, yBy: rect.height / 64)
        scale.concat()
        color("f2f4f8").setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 64, height: 64), xRadius: 15, yRadius: 15).fill()
        let path = NSBezierPath()
        // SVG has a top-left origin; AppKit's drawing origin is bottom-left.
        path.move(to: NSPoint(x: 17, y: 17))
        for point in [NSPoint(x: 28.5, y: 47), NSPoint(x: 35.5, y: 47), NSPoint(x: 47, y: 17),
                      NSPoint(x: 39, y: 17), NSPoint(x: 37, y: 23), NSPoint(x: 27, y: 23),
                      NSPoint(x: 25, y: 17)] { path.line(to: point) }
        path.close()
        path.move(to: NSPoint(x: 29, y: 30))
        path.line(to: NSPoint(x: 35, y: 30))
        path.line(to: NSPoint(x: 32, y: 39))
        path.close()
        path.windingRule = .evenOdd
        color("090c12").setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
    static var logo: NSImage {
        NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
            drawLogo(in: rect); return true
        }
    }
}

final class WalletBrandMark: NSView {
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 36).isActive = true
        heightAnchor.constraint(equalToConstant: 36).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Algoria logo")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func draw(_ dirtyRect: NSRect) { WalletDesign.drawLogo(in: bounds) }
}

final class WalletBadge: NSView {
    init(_ text: String) {
        super.init(frame: .zero)
        let label = NSTextField(labelWithString: text)
        label.font = WalletDesign.font(size: 10, weight: .medium, mono: true)
        label.textColor = WalletDesign.secondary
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 11),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -11),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 7),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -7),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7)
        WalletDesign.surface.setFill(); path.fill()
        WalletDesign.border.setStroke(); path.stroke()
    }
}

// Keep native button actions, accessibility and keyboard routing; only paint
// the brand treatment. Selection and disabled states are never color-only.
final class WalletButton: NSButton {
    enum Style { case primary, secondary, tab }
    let walletStyle: Style
    init(_ title: String, style: Style, target: AnyObject?, action: Selector?) {
        walletStyle = style
        super.init(frame: .zero)
        self.title = title; self.target = target; self.action = action
        bezelStyle = .rounded
        setButtonType(.momentaryPushIn)
        font = WalletDesign.font(size: style == .tab ? 12 : 13, weight: .medium)
        focusRingType = .exterior
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: style == .tab ? 36 : 44).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    // AppKit's rounded bezel has outsets; custom-painted controls do not.
    override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsetsZero }
    override func draw(_ dirtyRect: NSRect) {
        let selected = walletStyle == .tab && state == .on
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8)
        let foreground = walletStyle == .primary ? WalletDesign.background : selected ? WalletDesign.text : WalletDesign.secondary
        let fill = walletStyle == .primary ? WalletDesign.text : selected ? WalletDesign.elevated : WalletDesign.surface
        fill.withAlphaComponent(isEnabled ? (isHighlighted ? 0.75 : 1) : 0.35).setFill()
        path.fill()
        if walletStyle != .primary { WalletDesign.border.setStroke(); path.stroke() }
        if selected {
            WalletDesign.accent.setFill()
            let y: CGFloat = isFlipped ? bounds.height - 5 : 3
            NSBezierPath(roundedRect: NSRect(x: bounds.midX - 10, y: y, width: 20, height: 2), xRadius: 1, yRadius: 1).fill()
        }
        let attrs: [NSAttributedString.Key: Any] = [.font: font!, .foregroundColor: foreground.withAlphaComponent(isEnabled ? 1 : 0.5)]
        let text = title as NSString
        let size = text.size(withAttributes: attrs)
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)
        if window?.firstResponder === self {
            NSGraphicsContext.saveGraphicsState()
            NSFocusRingPlacement.only.set(); path.fill()
            NSGraphicsContext.restoreGraphicsState()
        }
    }
}
