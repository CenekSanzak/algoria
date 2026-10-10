import AppKit

// Presentation only. Production summaries come from the bundled validator;
// this window never constructs transactions, grants permissions or signs.
enum WalletReviewKind { case purchase, permission }

private let walletAccent = WalletDesign.accent

private final class WalletBackground: NSView {
    override func draw(_ dirtyRect: NSRect) {
        WalletDesign.background.setFill()
        bounds.fill()
    }
}

private final class WalletDocument: NSView {
    override var isFlipped: Bool { true }
}

private final class WalletSurface: NSView {
    let tint: Bool
    init(tint: Bool = false) { self.tint = tint; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func draw(_ dirtyRect: NSRect) {
        (tint ? WalletDesign.elevated : WalletDesign.surface).setFill()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 14, yRadius: 14)
        path.fill()
        WalletDesign.border.setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}

private func walletText(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular,
                        color: NSColor = WalletDesign.text, mono: Bool = false) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = WalletDesign.font(size: size, weight: weight, mono: mono)
    field.lineBreakMode = mono ? .byCharWrapping : .byWordWrapping
    field.textColor = color
    field.isSelectable = true
    field.maximumNumberOfLines = 0
    field.setContentCompressionResistancePriority(.required, for: .vertical)
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    return field
}

private func walletStack(_ views: [NSView], spacing: CGFloat = 12, horizontal: Bool = false) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = horizontal ? .horizontal : .vertical
    stack.alignment = horizontal ? .centerY : .leading
    stack.spacing = spacing
    if !horizontal {
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }
    return stack
}

private func walletPin(_ child: NSView, to parent: NSView, inset: CGFloat = 0) {
    parent.addSubview(child)
    child.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        child.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: inset),
        child.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -inset),
        child.topAnchor.constraint(equalTo: parent.topAnchor, constant: inset),
        child.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -inset),
    ])
}

private func walletIcon(_ name: String, description: String, size: CGFloat = 24) -> NSImageView {
    let view = NSImageView()
    view.image = NSImage(systemSymbolName: name, accessibilityDescription: description)
    view.contentTintColor = walletAccent
    view.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: size, weight: .medium)
    view.translatesAutoresizingMaskIntoConstraints = false
    view.widthAnchor.constraint(equalToConstant: size + 8).isActive = true
    view.heightAnchor.constraint(equalToConstant: size + 8).isActive = true
    return view
}

private func walletCard(_ title: String, _ views: [NSView]) -> NSView {
    let surface = WalletSurface()
    walletPin(walletStack([walletText(title, size: 13, weight: .medium)] + views, spacing: 12), to: surface, inset: 18)
    return surface
}

private func walletRow(_ name: String, _ value: String, mono: Bool = false) -> NSView {
    let label = walletText(name, size: 11, color: WalletDesign.muted)
    let content = walletText(value, size: mono ? 12 : 13, weight: .medium, mono: mono)
    content.setAccessibilityLabel(name)
    return walletStack([label, content], spacing: 4)
}

private func walletParseDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

private func walletDate(_ value: String) -> String {
    guard let date = walletParseDate(value) else { return value }
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .medium
    return "\(formatter.string(from: date)) · \(TimeZone.current.abbreviation(for: date) ?? TimeZone.current.identifier)"
}

final class WalletReviewController: NSWindowController, NSWindowDelegate {
    let kind: WalletReviewKind
    let summary: [String: Any]
    let preview: Bool
    private(set) var approved = false
    private(set) var selectedPage = 0
    private var modalActive = false
    private let pageHost = NSView()
    private var pages: [NSView] = []
    private var pageLabels: [String] = []
    private var tabs: [WalletButton] = []
    private var approveButton: NSButton!
    private var cancelButton: NSButton!
    private var expiryLabel: NSTextField!
    private var expiryTimer: Timer?
    private let sharedWindow: Bool

    init(summary: [String: Any], kind: WalletReviewKind, preview: Bool = false, journeyWindow: NSWindow? = nil) {
        self.summary = summary; self.kind = kind; self.preview = preview
        self.sharedWindow = journeyWindow != nil
        let available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1000, height: 900)
        let size = NSSize(width: min(640, available.width - 32),
                          height: min(780, available.height - 48))
        let window = journeyWindow ?? NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = preview ? "Algoria Wallet — Design preview" : "Algoria Wallet"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = WalletDesign.background
        NSApplication.shared.applicationIconImage = WalletDesign.logo
        window.contentView = WalletBackground(frame: NSRect(origin: .zero, size: size))
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        build()
        if !sharedWindow { window.center() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    private func value(_ key: String, from source: [String: Any]? = nil) -> String {
        (source ?? summary)[key].map { String(describing: $0) } ?? "Not attached"
    }
    private var permission: [String: Any]? { summary["permission"] as? [String: Any] }
    private var call: [String: Any]? { summary["call"] as? [String: Any] }

    private func build() {
        guard let content = window?.contentView else { return }
        let branding = walletStack([
            walletText("Algoria", size: 19, weight: .semibold),
            walletText("LOCAL WALLET", size: 9, color: WalletDesign.muted, mono: true),
        ], spacing: 2)
        let badge = WalletBadge("TEMPO · TESTNET")
        let spacer = NSView()
        let header = walletStack([WalletBrandMark(), branding, spacer, badge], horizontal: true)
        branding.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentHuggingPriority(.required, for: .horizontal)

        let hero = WalletSurface(tint: true)
        var heroViews: [NSView]
        if kind == .permission {
            heroViews = [walletText("SPENDING PERMISSION", size: 10, color: WalletDesign.muted, mono: true),
                         walletText(summary["replacement"] is String ? "Update your spending limit" : "Set your spending limit", size: 21, weight: .medium),
                         walletText(value("total"), size: 38, weight: .semibold, mono: true),
                         walletText("test PathUSD · lifetime budget", size: 12, color: WalletDesign.secondary),
                         walletText("No payment now. Touch ID is still required for every purchase.", size: 11, color: WalletDesign.muted)]
        } else {
            let amount = (summary["amount"] as? String).flatMap(Double.init).map { String(format: "%.6f", $0 / 1e6) } ?? "0.000001"
            heroViews = [walletText("PAYMENT REQUEST", size: 10, color: WalletDesign.muted, mono: true),
                         walletText(call != nil ? "Place one real phone call" : summary["prompt"] == nil ? "Review your self-transfer" : "Generate one image", size: 21, weight: .medium),
                         walletText(amount, size: 38, weight: .semibold, mono: true),
                         walletText("test PathUSD · \(call != nil ? "Algoria phone service" : summary["prompt"] == nil ? "your temporary account" : "Algoria image service")", size: 12, color: WalletDesign.secondary),
                         walletText(call != nil ? "Real call · test-token payment. Dialing is not simulated. Gas is separate." : "Test tokens only. No monetary value. Network fee is separate.", size: 11, color: call != nil ? WalletDesign.warning : WalletDesign.muted)]
        }
        walletPin(walletStack(heroViews, spacing: 6), to: hero, inset: 20)

        pageLabels = kind == .permission ? ["Overview", "Scope", "Limits & safety"] : ["Review", "Details", "Permission", "Activity"]
        tabs = pageLabels.enumerated().map { index, label in
            let tab = WalletButton(label, style: .tab, target: self, action: #selector(changePage(_:)))
            tab.tag = index
            tab.setAccessibilityHelp("Show \(label.lowercased()) details. Does not approve or sign.")
            return tab
        }
        let selector = walletStack(tabs, spacing: 6, horizontal: true)
        selector.distribution = .fillEqually
        selector.setAccessibilityLabel("Wallet details")
        pages = kind == .permission ? permissionPages() : purchasePages()
        showPage(0)

        expiryLabel = walletText(preview ? "Synthetic data · no keys, signing or network requests" : "Review first. Authenticate next.", size: 11, color: WalletDesign.muted)
        let security = walletStack([
            walletText(preview ? "Design preview only" : "Protected by Touch ID", size: 12, weight: .medium),
            expiryLabel,
        ], spacing: 3)
        approveButton = WalletButton(preview ? "Close preview" : kind == .permission ? "Set limit with Touch ID" : "Approve with Touch ID", style: .primary, target: self, action: #selector(approve(_:)))
        // No Return default: opening a window must not imply spending approval.
        approveButton.keyEquivalent = ""
        approveButton.setAccessibilityHelp(preview ? "Closes this preview without signing." : "Approves this exact request, then asks for Touch ID to sign.")
        cancelButton = WalletButton("Cancel", style: .secondary, target: self, action: #selector(cancel(_:)))
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityHelp("Close without returning a signed request.")
        let actions = walletStack([cancelButton, approveButton], spacing: 10, horizontal: true)
        cancelButton.widthAnchor.constraint(equalToConstant: 110).isActive = true
        approveButton.widthAnchor.constraint(equalTo: actions.widthAnchor, constant: -120).isActive = true
        let protection = walletStack([walletIcon(preview ? "eye" : "touchid", description: preview ? "Safe design preview" : "Touch ID protection", size: 20), security], spacing: 10, horizontal: true)
        let footer = WalletSurface()
        walletPin(walletStack([protection, actions], spacing: 14), to: footer, inset: 16)
        let root = walletStack([header, hero, selector, pageHost, footer], spacing: 16)
        walletPin(root, to: content, inset: 24)
        pageHost.setContentHuggingPriority(.defaultLow, for: .vertical)
        pageHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 100).isActive = true
        window?.initialFirstResponder = cancelButton
        updateExpiry()
    }

    private func updateExpiry(now: Date = Date()) {
        guard !preview else { return }
        guard let date = walletParseDate(value("expires")) else {
            approveButton.isEnabled = false
            approveButton.title = "Review unavailable"
            expiryLabel.stringValue = "Expiry could not be verified. Cancel and request a fresh review."
            expiryLabel.textColor = WalletDesign.danger
            return
        }
        let seconds = Int(ceil(date.timeIntervalSince(now)))
        approveButton.isEnabled = seconds > 0
        if seconds <= 0 {
            expiryLabel.stringValue = "Expired. Cancel and request a fresh review."
            expiryLabel.textColor = WalletDesign.danger
            approveButton.title = "Request expired"
        } else if kind == .purchase {
            expiryLabel.stringValue = "Expires in \(seconds / 60)m \(seconds % 60)s · nothing signed yet"
            expiryLabel.textColor = seconds < 60 ? WalletDesign.warning : WalletDesign.muted
        } else {
            expiryLabel.stringValue = "Valid until \(walletDate(value("expires"))) · no payment now"
        }
    }

    private func scrollPage(_ cards: [NSView]) -> NSView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let stack = walletStack(cards, spacing: 12)
        let document = WalletDocument()
        scroll.documentView = document
        document.translatesAutoresizingMaskIntoConstraints = false
        // Bind width only; height follows content so long prompts remain visible.
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
        ])
        walletPin(stack, to: document, inset: 2)
        return scroll
    }

    private func purchasePages() -> [NSView] {
        let prompt = call?["goal"] as? String ?? summary["prompt"] as? String ?? "Transfer one micro-unit back to this same temporary account."
        let promptView: NSView
        if prompt.count > 260 {
            let scroll = scrollPage([walletText(prompt, size: 14)])
            scroll.heightAnchor.constraint(equalToConstant: 100).isActive = true
            scroll.setAccessibilityLabel("Full request · scroll to read")
            promptView = scroll
        } else { promptView = walletText(prompt, size: 14) }
        var requestViews: [NSView] = []
        if let call {
            requestViews += [walletRow("Approved contact", value("contact", from: call)),
                             walletText("CALL GOAL", size: 10, color: WalletDesign.muted, mono: true)]
        }
        requestViews.append(promptView)
        if let call {
            requestViews.append(walletText("\(value("language", from: call) == "tr" ? "Turkish" : "English") · calling on behalf of \(value("on_behalf_of", from: call))", size: 12, color: WalletDesign.secondary))
        }
        if call != nil {
            requestViews.append(walletText("This will call a real person. Test tokens do not make the call simulated. Once dialed, closing this wallet cannot cancel the call.", size: 12, color: WalletDesign.warning))
        }
        let gas = UInt64(value("gasLimit")) ?? 0
        let fee = UInt64(value("maxFeePerGas")) ?? 0
        let maximumFee = (gas * fee + 999_999_999_999) / 1_000_000_000_000
        let feeText = "\(maximumFee / 1_000_000).\(String(format: "%06llu", maximumFee % 1_000_000)) test PathUSD"
        let review = scrollPage([
            walletCard(call != nil ? "Real call · review before approving" : "Request", requestViews),
            walletCard("Payment", [walletRow("Maximum network fee · separate from service price", feeText),
                                    walletText("Tempo testnet · temporary wallet · test tokens only", size: 12, color: WalletDesign.secondary)]),
            walletCard("What approval means", [walletText("Touch ID signs only this exact transaction. The plugin may then submit it. Cancel now to return no signed payment.", size: 12),
                                               walletText("A submitted payment cannot be undone by closing this window.", size: 12, color: WalletDesign.muted)]),
        ])
        let wallet = scrollPage([
            walletCard("Transaction details", [walletRow("Payment recipient · full address", value(summary["recipient"] == nil ? "address" : "recipient"), mono: true),
                walletRow("Network", value("network")), walletRow("Valid until", walletDate(value("expires")))]),
            walletCard("Temporary testnet wallet", [walletText("A disposable Secure Enclave key is used for this request. It is discarded when this process exits. Your existing wallet is never opened.", size: 13),
                                                    walletRow("Account · full address", value("address"), mono: true),
                                                    walletText("Never send real funds here. Any remaining test tokens are abandoned.", size: 12, color: WalletDesign.muted)]),
            walletCard("Asset & fee bounds", [walletRow("Token contract · test PathUSD", value("token"), mono: true),
                                              walletRow("Gas limit", value("gasLimit")),
                                              walletRow("Maximum fee per gas · protocol units", value("maxFeePerGas")),
                                              walletText("These are upper bounds, not a final fee quote. The plugin checks test PathUSD and automatically requests faucet tokens when needed before this review. If insufficient, it asks for a test-token top-up first.", size: 12, color: WalletDesign.muted)]),
        ])
        var permissionCards: [NSView] = []
        if let p = permission {
            permissionCards.append(walletCard("Attached spending permission", [walletRow("Budget", value("budget", from: p)),
                walletRow("Lifetime cap", "\(value("total", from: p)) test PathUSD"),
                walletRow("Per purchase", "\(value("perCall", from: p)) test PathUSD"),
                walletRow("Expires", walletDate(value("expires", from: p))),
                walletRow("Host label · not a verified identity", value("agent", from: p)),
                walletRow("Permission ID", value("id", from: p), mono: true)]))
        } else {
            permissionCards.append(walletCard("One-request approval", [walletText("No reusable spending permission is attached to this signing proof.")]))
        }
        permissionCards.append(walletCard("Local protection, not delegation", [walletText("The native builder checks signed scope, the per-purchase cap and expiry. The plugin checks cumulative spending and revocation in its local ledger.", size: 12),
            walletText("Every purchase still needs Touch ID. This is not on-chain enforcement or full ERC-8196 compliance. No remaining balance is claimed here.", size: 12, color: WalletDesign.muted)]))
        let activity = scrollPage([
            walletCard("Awaiting your approval", [walletRow("Current job", summary["jobId"] == nil ? "Signing proof" : value("jobId"), mono: true),
                                                   walletText("This is the current request, not a complete wallet history. No signed transaction has been returned yet.", size: 12)]),
            walletCard("If the flow is interrupted", [walletText("Resume the same saved job. The plugin keeps receipts and recovery state locally. Do not start a new payment or redial to recover a missing result.", size: 13),
                                                      walletText("Revocation stops future local dispatches. It cannot undo a submitted payment or erase an uncertain reservation.", size: 12, color: WalletDesign.muted)]),
        ])
        return [review, wallet, scrollPage(permissionCards), activity]
    }

    private func permissionPages() -> [NSView] {
        let overview = scrollPage([
            walletCard("Spending limits", [walletRow("Budget", value("budget")),
                                          walletRow("Maximum per purchase", "\(value("perCall")) test PathUSD"),
                                          walletRow("Expires", walletDate(value("expires"))),
                                          walletText("Updating a permission preserves spent amounts and uncertain reservations. The lifetime cap is not your available balance.", size: 12, color: WalletDesign.muted)]),
            walletCard("You stay in control", [walletText("This approval sets local limits. It does not pay, fund a wallet or allow unattended signing. Each purchase requires a separate Touch ID approval.", size: 13)]),
        ])
        let scope = scrollPage([
            walletCard("Allowed service", [walletRow("Service", value("service")),
                                          walletRow("Endpoint · full URL", value("resource"), mono: true),
                                          walletRow("Host label · not a verified identity", value("agent"))]),
            walletCard("Allowed destination", [walletRow("Recipient · full address", value("recipient"), mono: true),
                                               walletRow("Network", value("network")),
                                               walletRow("Token contract · test PathUSD", value("token"), mono: true)]),
        ])
        let safety = scrollPage([
            walletCard("Permission boundary", [walletText("Limits and revocation are local to the plugin. They are not an on-chain policy, an autonomous signer, or full ERC-8196 compliance. Gas is separate from the service budget.", size: 13),
                                                walletRow("Permission ID", value("policyId"), mono: true)]),
            walletCard("Changing your mind", [walletText("Cancel now: no permission receipt is returned. After approval, revoke the budget through the plugin to stop future local dispatches.", size: 13),
                                             walletText("Revocation cannot undo a submitted payment, a signature already returned, or a dispatch already saved for recovery.", size: 12, color: WalletDesign.muted)]),
        ])
        return [overview, scope, safety]
    }

    func showPage(_ index: Int) {
        guard pages.indices.contains(index) else { return }
        pageHost.subviews.forEach { $0.removeFromSuperview() }
        walletPin(pages[index], to: pageHost)
        selectedPage = index
        for (tabIndex, tab) in tabs.enumerated() {
            tab.state = tabIndex == index ? .on : .off
            tab.needsDisplay = true
            tab.setAccessibilityValue(tabIndex == index ? "Selected" : "Not selected")
        }
        pageHost.setAccessibilityLabel(pageLabels[index])
    }
    @objc private func changePage(_ sender: NSButton) { showPage(sender.tag) }
    @objc private func approve(_ sender: Any?) {
        updateExpiry()
        guard approveButton.isEnabled else { return }
        finish(approved: !preview)
    }
    @objc private func cancel(_ sender: Any?) { finish(approved: false) }
    private func finish(approved: Bool) {
        self.approved = approved
        expiryTimer?.invalidate(); expiryTimer = nil
        if modalActive { NSApplication.shared.stopModal(withCode: approved ? .OK : .cancel) }
        if !sharedWindow { window?.orderOut(nil) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { finish(approved: false); return true }
    func runReview() -> Bool {
        guard let window else { return false }
        modalActive = true
        if !preview {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.updateExpiry() }
            expiryTimer = timer
            RunLoop.main.add(timer, forMode: .modalPanel)
        }
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.runModal(for: window)
        modalActive = false
        expiryTimer?.invalidate(); expiryTimer = nil
        if !sharedWindow { window.orderOut(nil) }
        return approved
    }

    // Explicit fixture modes never reach key creation, SDK signing, or RPC.
    static func fixture(_ kind: WalletReviewKind, longPrompt: Bool = false, phone: Bool = false) -> [String: Any] {
        let service = phone ? "phone.call" : "image.generate"
        let policy: [String: Any] = ["id": "00000000-0000-0000-0000-000000000001", "budget": phone ? "demo-calls" : "demo-images", "agent": "codex",
            "total": "5.000000", "perCall": "0.100000", "expires": "2030-10-05T18:30:00Z"]
        let scope: [String: Any] = ["network": "Tempo Moderato (42431)", "token": "0x20c0000000000000000000000000000000000000",
            "recipient": "0x1111111111111111111111111111111111111111"]
        if kind == .permission {
            return scope.merging(policy) { _, new in new }.merging(["policyId": policy["id"]!, "service": service,
                "resource": "https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/\(service)"]) { _, new in new }
        }
        let input: [String: Any] = phone ? ["call": ["contact": "berkin", "goal": longPrompt ? String(repeating: "Confirm the demo in İstanbul. ", count: 30) : "Remind him about the hackathon demo at 3pm and ask if he is ready.", "on_behalf_of": "Dogukan", "language": "tr"]] : ["prompt": longPrompt ? String(repeating: "A quiet Japanese garden with warm morning light. ", count: 80) : "A quiet Japanese garden with warm morning light, soft mist and a small wooden bridge. Editorial photography, natural colours."]
        return scope.merging(input) { _, new in new }.merging(["service": service,
            "amount": phone ? "100000" : "10000", "address": "0x2222222222222222222222222222222222222222", "gasLimit": "1000000",
            "maxFeePerGas": "20000000000", "expires": "2030-10-05T18:30:00Z", "permission": policy,
            "jobId": "00000000-0000-0000-0000-000000000002"]) { _, new in new }
    }

    static func renderPreviews(to directory: String) throws -> [String] {
        guard directory.hasPrefix("/"), FileManager.default.fileExists(atPath: directory) else { throw fail("PREVIEW_DIRECTORY_REQUIRED") }
        var paths: [String] = []
        for dark in [false, true] {
            for (kind, phone) in [(WalletReviewKind.purchase, false), (.permission, false), (.purchase, true), (.permission, true)] {
                let controller = WalletReviewController(summary: fixture(kind, phone: phone), kind: kind, preview: true)
                controller.window?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                guard let view = controller.window?.contentView else { throw fail("PREVIEW_RENDER_FAILED") }
                for index in controller.pages.indices {
                    controller.showPage(index)
                    view.layoutSubtreeIfNeeded()
                    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw fail("PREVIEW_RENDER_FAILED") }
                    view.effectiveAppearance.performAsCurrentDrawingAppearance {
                        view.cacheDisplay(in: view.bounds, to: bitmap)
                    }
                    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw fail("PREVIEW_RENDER_FAILED") }
                    let name = "\(phone ? "phone-" : "")\(kind == .purchase ? "purchase" : "budget")-\(index)-\(dark ? "dark" : "light").png"
                    let path = URL(fileURLWithPath: directory).appendingPathComponent(name)
                    try png.write(to: path, options: .atomic)
                    paths.append(path.path)
                }
                controller.window?.close()
            }
            paths.append(try WalletFundingController.renderPreview(to: directory, dark: dark))
            paths.append(contentsOf: try WalletJourneyController.renderPreview(to: directory, dark: dark))
        }
        return paths
    }

    static func selfTest() throws -> [String: Any] {
        guard WalletDesign.font(size: 13).fontName == "Prompt-Regular",
              WalletDesign.font(size: 13, weight: .medium).fontName == "Prompt-Medium",
              WalletDesign.font(size: 13, weight: .semibold).fontName == "Prompt-SemiBold",
              WalletDesign.font(size: 13, mono: true).fontName.hasPrefix("GeistMono"),
              Bundle.main.url(forResource: "algoria-logo", withExtension: "svg") != nil else {
            throw fail("UI_BRAND_ASSETS_FAILED")
        }
        for (kind, phone) in [(WalletReviewKind.purchase, false), (.permission, false), (.purchase, true), (.permission, true)] {
            let controller = WalletReviewController(summary: fixture(kind, longPrompt: true, phone: phone), kind: kind, preview: true)
            controller.window?.contentView?.layoutSubtreeIfNeeded()
            for index in controller.pages.indices {
                controller.tabs[index].performClick(nil)
                controller.window?.contentView?.layoutSubtreeIfNeeded()
                guard controller.tabs[index].state == .on,
                      controller.tabs.filter({ $0.state == .on }).count == 1 else { throw fail("UI_TAB_SELECTION_FAILED") }
            }
            // Fixed approval controls must fit, with a real gap rather than
            // native rounded-bezel alignment outsets causing painted overlap.
            for size in [NSSize(width: 640, height: 730), NSSize(width: 560, height: 620)] {
                controller.window?.setContentSize(size)
                guard let content = controller.window?.contentView else { throw fail("UI_LAYOUT_FAILED") }
                content.layoutSubtreeIfNeeded()
                let cancel = controller.cancelButton.convert(controller.cancelButton.bounds, to: content)
                let approve = controller.approveButton.convert(controller.approveButton.bounds, to: content)
                guard content.bounds.contains(cancel), content.bounds.contains(approve),
                      cancel.maxX + 8 <= approve.minX,
                      approve.width >= 260, controller.pageHost.bounds.height >= 100 else { throw fail("UI_LAYOUT_FAILED") }
            }
            guard !controller.approved, controller.selectedPage == controller.pages.count - 1,
                  controller.cancelButton.keyEquivalent == "\u{1b}", controller.approveButton.keyEquivalent.isEmpty,
                  controller.window?.initialFirstResponder === controller.cancelButton else { throw fail("UI_SAFETY_FAILED") }
            controller.approve(nil)
            guard !controller.approved else { throw fail("PREVIEW_APPROVAL_FAILED") }
            controller.window?.close()
            let live = WalletReviewController(summary: fixture(kind), kind: kind)
            live.updateExpiry(now: walletParseDate(live.value("expires"))!.addingTimeInterval(-30))
            guard live.approveButton.isEnabled else { throw fail("UI_FRESH_EXPIRY_FAILED") }
            live.approve(nil)
            guard live.approved else { throw fail("UI_APPROVAL_FAILED") }
            live.cancel(nil)
            guard !live.approved else { throw fail("UI_CANCEL_FAILED") }
            _ = live.windowShouldClose(live.window!)
            guard !live.approved else { throw fail("UI_CLOSE_FAILED") }
            live.window?.close()
            for expiry in ["2020-01-01T00:00:00Z", "2020-01-01T00:00:00.123Z", "invalid"] {
                var expired = fixture(kind)
                expired["expires"] = expiry
                let stale = WalletReviewController(summary: expired, kind: kind)
                stale.approve(nil)
                guard !stale.approved, !stale.approveButton.isEnabled else { throw fail("UI_EXPIRED_APPROVAL_FAILED") }
                stale.window?.close()
            }
        }
        return ["status": "ui-self-test-passed", "keyCreated": false, "signed": false, "networkRequests": false]
    }
}

// A funding-only prompt. The same temporary key stays alive; checking a balance
// neither signs a payment nor grants spending authority.
final class WalletFundingController: NSWindowController, NSWindowDelegate {
    let summary: [String: Any]
    let preview: Bool
    private var checked = false
    private var modalActive = false
    private var checkButton: NSButton!
    private var cancelButton: NSButton!
    private var expiryLabel: NSTextField!
    private let sharedWindow: Bool
    init(summary: [String: Any], preview: Bool = false, journeyWindow: NSWindow? = nil) {
        self.summary = summary; self.preview = preview
        self.sharedWindow = journeyWindow != nil
        let available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1000, height: 900)
        let size = NSSize(width: min(620, available.width - 32), height: min(740, available.height - 48))
        let window = journeyWindow ?? NSWindow(contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = preview ? "Algoria Wallet — Funding preview" : "Algoria Wallet — Test tokens"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = WalletDesign.background
        window.contentView = WalletBackground(frame: NSRect(origin: .zero, size: size))
        window.isReleasedWhenClosed = false
        NSApplication.shared.applicationIconImage = WalletDesign.logo
        super.init(window: window)
        window.delegate = self
        let value = { (key: String) in summary[key] as? String ?? "Unavailable" }
        let header = walletStack([WalletBrandMark(), walletText("Algoria", size: 19, weight: .semibold), NSView(), WalletBadge("TEMPO · TESTNET")], horizontal: true)
        let hero = walletCard("ADD TEST TOKENS", [walletText("Your wallet needs a top-up", size: 23, weight: .medium),
            walletText(value("shortfall"), size: 36, weight: .semibold, mono: true),
            walletText("test PathUSD · minimum amount to add", size: 12, color: WalletDesign.secondary),
            walletText("Automatic funding was insufficient or disabled. Keep this wallet open. Never send real funds.", size: 12, color: WalletDesign.muted)])
        let scroll = NSScrollView()
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        let document = WalletDocument(); scroll.documentView = document
        document.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor), document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor)])
        walletPin(walletStack([
            walletCard("Funding details", [walletRow("Current balance · test PathUSD", value("balance")),
                walletRow("Required balance · price + maximum fee", value("required")),
                walletRow("Temporary wallet · copy the full address", value("address"), mono: true),
                walletRow("Token contract · Tempo Moderato (42431)", value("token"), mono: true)]),
            walletCard("Keep this wallet open", [walletText("Add test PathUSD to this address, then check the balance. Checking does not approve the purchase.", size: 13),
                walletText("Never send real funds. This temporary address expires when the wallet closes; leftover test tokens are abandoned.", size: 12, color: WalletDesign.warning)]),
        ]), to: document, inset: 2)
        expiryLabel = walletText(preview ? "Synthetic data · no keys or network" : "Temporary wallet · no payment signed", size: 11, color: WalletDesign.muted)
        checkButton = WalletButton(preview ? "Close preview" : "Check balance", style: .primary, target: self, action: #selector(check(_:)))
        checkButton.keyEquivalent = ""
        checkButton.setAccessibilityHelp("Checks for test tokens. Does not sign or approve a payment.")
        cancelButton = WalletButton("Cancel", style: .secondary, target: self, action: #selector(cancel(_:)))
        cancelButton.keyEquivalent = "\u{1b}"
        let actions = walletStack([cancelButton, checkButton], spacing: 10, horizontal: true)
        cancelButton.widthAnchor.constraint(equalToConstant: 110).isActive = true
        checkButton.widthAnchor.constraint(equalTo: actions.widthAnchor, constant: -120).isActive = true
        let footer = walletCard("No signing at this step", [expiryLabel, actions])
        walletPin(walletStack([header, hero, scroll, footer], spacing: 16), to: window.contentView!, inset: 24)
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 100).isActive = true
        window.initialFirstResponder = cancelButton
        if !sharedWindow { window.center() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    private var expired: Bool { (walletParseDate(summary["expires"] as? String ?? "") ?? .distantPast) <= Date() }
    @objc private func check(_ sender: Any?) { finish(!preview && !expired) }
    @objc private func cancel(_ sender: Any?) { finish(false) }
    private func finish(_ checked: Bool) {
        self.checked = checked
        if modalActive { NSApplication.shared.stopModal(withCode: checked ? .OK : .cancel) }
        if !sharedWindow { window?.orderOut(nil) }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { finish(false); return true }
    func runReview() -> Bool {
        guard let window, preview || !expired else { return false }
        let timer = Timer(timeInterval: 1, repeats: true) { [self] _ in
            guard !self.preview else { return }
            let seconds = max(0, Int((walletParseDate(self.summary["expires"] as? String ?? "") ?? .distantPast).timeIntervalSinceNow))
            self.expiryLabel.stringValue = "Top-up window: \(seconds / 60)m \(seconds % 60)s · no payment signed"
            if self.expired { self.finish(false) }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        modalActive = true
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.runModal(for: window)
        modalActive = false
        timer.invalidate()
        if !sharedWindow { window.orderOut(nil) }
        return !preview && checked && !expired
    }
    static func fixture() -> [String: Any] {
        ["balance": "0.000000", "required": "0.030000", "shortfall": "0.030000",
         "address": "0x2222222222222222222222222222222222222222",
         "token": "0x20c0000000000000000000000000000000000000", "expires": "2030-10-05T18:30:00Z"]
    }
    static func selfTest() throws {
        let controller = WalletFundingController(summary: fixture(), preview: true)
        controller.window?.contentView?.layoutSubtreeIfNeeded()
        guard controller.checkButton.keyEquivalent.isEmpty, controller.cancelButton.keyEquivalent == "\u{1b}",
              controller.window?.initialFirstResponder === controller.cancelButton else { throw fail("FUNDING_UI_SAFETY_FAILED") }
        for size in [NSSize(width: 620, height: 740), NSSize(width: 560, height: 620)] {
            controller.window?.setContentSize(size)
            guard let content = controller.window?.contentView else { throw fail("FUNDING_UI_LAYOUT_FAILED") }
            content.layoutSubtreeIfNeeded()
            let cancel = controller.cancelButton.convert(controller.cancelButton.bounds, to: content)
            let check = controller.checkButton.convert(controller.checkButton.bounds, to: content)
            guard content.bounds.contains(cancel), content.bounds.contains(check), cancel.maxX + 8 <= check.minX else { throw fail("FUNDING_UI_LAYOUT_FAILED") }
        }
        controller.check(nil)
        guard !controller.checked else { throw fail("FUNDING_PREVIEW_CHECK_FAILED") }
        controller.window?.close()
        let live = WalletFundingController(summary: fixture())
        live.check(nil)
        guard live.checked else { throw fail("FUNDING_CHECK_FAILED") }
        _ = live.windowShouldClose(live.window!)
        guard !live.checked else { throw fail("FUNDING_CLOSE_FAILED") }
        live.window?.close()
        var expired = fixture(); expired["expires"] = "2020-01-01T00:00:00Z"
        guard !WalletFundingController(summary: expired).runReview() else { throw fail("FUNDING_UI_EXPIRY_FAILED") }
    }
    static func renderPreview(to directory: String, dark: Bool) throws -> String {
        let controller = WalletFundingController(summary: fixture(), preview: true)
        controller.window?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        guard let view = controller.window?.contentView else { throw fail("PREVIEW_RENDER_FAILED") }
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw fail("PREVIEW_RENDER_FAILED") }
        view.effectiveAppearance.performAsCurrentDrawingAppearance { view.cacheDisplay(in: view.bounds, to: bitmap) }
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw fail("PREVIEW_RENDER_FAILED") }
        let path = URL(fileURLWithPath: directory).appendingPathComponent("funding-\(dark ? "dark" : "light").png")
        try png.write(to: path, options: .atomic)
        controller.window?.close()
        return path.path
    }
}

// One visible window for preparation, exact native reviews and read-only status.
// Status messages cannot grant permission, construct a payment or sign again.
final class WalletJourneyController: NSWindowController, NSWindowDelegate {
    private(set) var closed = false
    private(set) var signed = false
    private(set) var stage = "preparing"
    private(set) var transaction: String?
    private var summary: [String: Any] = [:]
    private var closeButton: NSButton!
    private var explorerButton: NSButton!
    private let preview: Bool
    private let contentSize: NSSize
    private let stages: [String: (String, String, Int)] = [
        "preparing": ("Preparing your payment", "Checking the temporary testnet wallet. Nothing signed yet.", 0),
        "funding": ("Preparing your payment", "Adding test tokens automatically. No real funds.", 0),
        "authenticating": ("Approve with Touch ID", "Authenticate to sign only the purchase you just reviewed.", 1),
        "confirming-payment": ("Confirming your payment", "Following the saved transaction. No second payment will be signed.", 2),
        "paid": ("Payment confirmed", "Continue this saved task in your assistant. No additional payment.", 2),
        "starting": ("Starting your service", "Your approved request is being submitted.", 3),
        "queued": ("Your request is queued", "Waiting for the service. Follow this same task.", 3),
        "generating": ("Creating your image", "Your assistant will show the result in your conversation.", 3),
        "calling": ("Your call is in progress", "This is a real call. Closing this window will not end it.", 3),
        "saving": ("Preparing your result", "Saving the result for delivery in your conversation.", 3),
        "preparing-delivery": ("Preparing your result", "Refreshing access to your saved result.", 3),
        "ready": ("Your result is ready", "Return to your assistant to see the image or call summary and receipt.", 4),
        "failed": ("The service could not finish", "Check the saved task and receipt in your assistant. No automatic retry or refund.", 3),
        "needs-attention": ("Your task is saved", "Payment or execution needs verification. Resume the same task; do not pay again.", 2),
        "paused": ("Continue in your assistant", "Your task is saved. Resume this same task to check its progress.", 3),
    ]

    init(preview: Bool = false) {
        self.preview = preview
        let available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1000, height: 900)
        let size = NSSize(width: min(640, available.width - 32), height: min(780, available.height - 48))
        contentSize = size
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = preview ? "Algoria Wallet — Journey preview" : "Algoria Wallet"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = WalletDesign.background
        window.isReleasedWhenClosed = false
        NSApplication.shared.applicationIconImage = WalletDesign.logo
        super.init(window: window)
        window.center()
        show("preparing")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func attach(_ summary: [String: Any]) { self.summary = summary }
    func markSigned() { signed = true; show("confirming-payment") }

    func show(_ stage: String) {
        guard !closed, let model = stages[stage], let window else { return }
        self.stage = stage
        window.delegate = self
        let root = WalletBackground(frame: NSRect(origin: .zero, size: contentSize))
        root.autoresizingMask = [.width, .height]
        window.contentView = root
        window.setContentSize(contentSize)
        let header = walletStack([WalletBrandMark(), walletText("Algoria", size: 19, weight: .semibold), NSView(), WalletBadge("TEMPO · TESTNET")], horizontal: true)
        let terminal = ["ready", "failed", "needs-attention", "paused", "paid"].contains(stage)
        let spinner = NSProgressIndicator()
        spinner.style = .spinning; spinner.controlSize = .regular
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([spinner.widthAnchor.constraint(equalToConstant: 32), spinner.heightAnchor.constraint(equalToConstant: 32)])
        if !terminal { spinner.startAnimation(nil) }
        let indicator: NSView = terminal ? walletIcon(stage == "ready" ? "checkmark.circle" : "info.circle", description: model.0, size: 36) : spinner
        // Keep the fixed-size icon OUT of the width-stretched vertical stack.
        // Otherwise its width constraint shrinks the entire window in AppKit.
        let indicatorHost = NSView()
        indicatorHost.addSubview(indicator)
        NSLayoutConstraint.activate([indicatorHost.heightAnchor.constraint(equalToConstant: 44),
            indicator.leadingAnchor.constraint(equalTo: indicatorHost.leadingAnchor),
            indicator.centerYAnchor.constraint(equalTo: indicatorHost.centerYAnchor)])
        var hero: [NSView] = [indicatorHost, walletText(model.0, size: 25, weight: .medium), walletText(model.1, size: 13, color: WalletDesign.secondary)]
        if let amount = summary["amount"] as? String, let atomic = UInt64(amount) {
            let price = "\(atomic / 1_000_000).\(String(format: "%06llu", atomic % 1_000_000))"
            hero.append(walletText("\(price) test PathUSD · service price", size: 13, weight: .medium, mono: true))
        }
        let steps = walletStack(["Prepare", "Touch ID", "Payment", "Result"].enumerated().map { index, label in
            walletText("\(index < model.2 ? "✓" : "\(index + 1)")  \(label)", size: 11, weight: index == model.2 ? .medium : .regular,
                       color: index <= model.2 ? WalletDesign.text : WalletDesign.muted)
        }, spacing: 8, horizontal: true)
        steps.distribution = .fillEqually
        closeButton = WalletButton(signed ? "Return to assistant" : "Cancel", style: .secondary, target: self, action: #selector(closeJourney(_:)))
        closeButton.keyEquivalent = "\u{1b}"
        closeButton.setAccessibilityHelp(signed ? "Closes this status window. Does not cancel a submitted payment or call." : "Stops before purchase signing.")
        explorerButton = WalletButton("View transaction", style: .secondary, target: self, action: #selector(openExplorer(_:)))
        explorerButton.isHidden = transaction == nil
        explorerButton.isEnabled = !preview
        let footer = walletStack([walletText(preview ? "Synthetic preview · no keys, signing or network" : signed ? "Task saved · closing does not cancel a submitted payment or call" : "Temporary wallet · test tokens only · nothing signed yet", size: 11, color: WalletDesign.muted),
            walletStack([explorerButton, closeButton], spacing: 10, horizontal: true)], spacing: 12)
        let space = NSView()
        walletPin(walletStack([header, steps, walletCard("YOUR REQUEST", hero), space, footer], spacing: 22), to: root, inset: 24)
        space.setContentHuggingPriority(.defaultLow, for: .vertical)
        window.initialFirstResponder = closeButton
        if !preview && !window.isVisible { window.makeKeyAndOrderFront(nil) }
    }

    // Only bounded, fixed presentation fields cross the post-signing pipe.
    func update(_ object: [String: Any]) throws {
        guard Set(object.keys).isSubset(of: ["type", "stage", "transaction"]),
              object["type"] as? String == "wallet-progress",
              let next = object["stage"] as? String, stages[next] != nil,
              signed || ["preparing", "funding"].contains(next) else { throw fail("INVALID_WALLET_PROGRESS") }
        if let hash = object["transaction"] as? String {
            guard signed, hash.range(of: "^0x[0-9a-fA-F]{64}$", options: .regularExpression) != nil,
                  transaction == nil || transaction == hash else { throw fail("INVALID_WALLET_RECEIPT") }
            transaction = hash
        } else if object["transaction"] != nil { throw fail("INVALID_WALLET_RECEIPT") }
        show(next)
    }
    @objc private func closeJourney(_ sender: Any?) { closed = true; window?.orderOut(nil) }
    @objc private func openExplorer(_ sender: Any?) {
        guard !preview, let transaction, let url = URL(string: "https://explore.testnet.tempo.xyz/tx/\(transaction)") else { return }
        NSWorkspace.shared.open(url)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { closeJourney(nil); return true }
    func finish() {
        let deadline = Date().addingTimeInterval(8)
        while !closed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        window?.orderOut(nil)
    }
    static func selfTest() throws {
        let controller = WalletJourneyController(preview: true)
        let window = controller.window!
        controller.show("funding")
        guard controller.window === window, !controller.signed, controller.explorerButton.isHidden,
              controller.closeButton.keyEquivalent == "\u{1b}" else { throw fail("JOURNEY_SAFETY_FAILED") }
        do { try controller.update(["type": "wallet-progress", "stage": "ready"]); throw fail("JOURNEY_UNSIGNED_SUCCESS") }
        catch let error as ProofError where error.code == "INVALID_WALLET_PROGRESS" {}
        controller.markSigned()
        let hash = "0x" + String(repeating: "a", count: 64)
        try controller.update(["type": "wallet-progress", "stage": "generating", "transaction": hash])
        try controller.update(["type": "wallet-progress", "stage": "ready", "transaction": hash])
        guard controller.window === window, controller.stage == "ready" else { throw fail("JOURNEY_WINDOW_CHANGED") }
        for size in [NSSize(width: 640, height: 780), NSSize(width: 560, height: 620)] {
            window.setContentSize(size); window.contentView?.layoutSubtreeIfNeeded()
            guard let root = window.contentView, abs(root.bounds.width - size.width) < 1,
                  root.bounds.contains(controller.closeButton.convert(controller.closeButton.bounds, to: root)),
                  root.bounds.contains(controller.explorerButton.convert(controller.explorerButton.bounds, to: root)) else { throw fail("JOURNEY_LAYOUT_FAILED") }
        }
        do { try controller.update(["type": "wallet-progress", "stage": "ready", "transaction": "https://evil.invalid"]); throw fail("JOURNEY_INVALID_HASH") }
        catch let error as ProofError where error.code == "INVALID_WALLET_RECEIPT" {}
        controller.closeJourney(nil)
        guard controller.closed, controller.signed else { throw fail("JOURNEY_CLOSE_FAILED") }
        window.close()
    }
    static func renderPreview(to directory: String, dark: Bool) throws -> [String] {
        let controller = WalletJourneyController(preview: true)
        controller.attach(WalletReviewController.fixture(.purchase))
        controller.window?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        var paths: [String] = []
        for stage in ["preparing", "confirming-payment", "generating", "ready", "needs-attention"] {
            if stage != "preparing" {
                controller.markSigned()
                try controller.update(["type": "wallet-progress", "stage": stage, "transaction": "0x" + String(repeating: "a", count: 64)])
            }
            controller.show(stage)
            guard let view = controller.window?.contentView else { throw fail("PREVIEW_RENDER_FAILED") }
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw fail("PREVIEW_RENDER_FAILED") }
            view.effectiveAppearance.performAsCurrentDrawingAppearance { view.cacheDisplay(in: view.bounds, to: bitmap) }
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw fail("PREVIEW_RENDER_FAILED") }
            let path = URL(fileURLWithPath: directory).appendingPathComponent("journey-\(stage)-\(dark ? "dark" : "light").png")
            try png.write(to: path, options: .atomic); paths.append(path.path)
        }
        controller.window?.close()
        return paths
    }
}
