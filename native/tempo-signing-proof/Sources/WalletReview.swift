import AppKit

// Presentation only. Production summaries come from the bundled validator;
// this window never constructs transactions, grants permissions or signs.
enum WalletReviewKind { case purchase, permission }

private let walletAccent = NSColor(name: "Algoria accent") { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(red: 0.33, green: 0.85, blue: 0.72, alpha: 1)
        : NSColor(red: 0.04, green: 0.40, blue: 0.33, alpha: 1)
}

private final class WalletBackground: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
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
        (tint ? walletAccent.withAlphaComponent(0.08) : NSColor.controlBackgroundColor).setFill()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 14, yRadius: 14)
        path.fill()
        NSColor.labelColor.withAlphaComponent(0.10).setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}

private func walletText(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular,
                        color: NSColor = .labelColor, mono: Bool = false) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = mono ? .monospacedSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight)
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
    walletPin(walletStack([walletText(title, size: 14, weight: .semibold)] + views, spacing: 12), to: surface, inset: 18)
    return surface
}

private func walletRow(_ name: String, _ value: String, mono: Bool = false) -> NSView {
    let label = walletText(name, size: 12, color: .secondaryLabelColor)
    let content = walletText(value, size: mono ? 12 : 13, weight: .medium, mono: mono)
    content.setAccessibilityLabel(name)
    return walletStack([label, content], spacing: 4)
}

private func walletDate(_ value: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: value) else { return value }
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
    private var selector: NSSegmentedControl!
    private var approveButton: NSButton!
    private var cancelButton: NSButton!
    private var expiryLabel: NSTextField!
    private var expiryTimer: Timer?

    init(summary: [String: Any], kind: WalletReviewKind, preview: Bool = false) {
        self.summary = summary; self.kind = kind; self.preview = preview
        let available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1000, height: 900)
        let size = NSSize(width: min(740, max(640, available.width - 48)),
                          height: min(760, max(580, available.height - 60)))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = preview ? "Algoria Wallet — Design preview" : "Algoria Wallet"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .windowBackgroundColor
        window.contentView = WalletBackground(frame: NSRect(origin: .zero, size: size))
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        build()
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    private func value(_ key: String, from source: [String: Any]? = nil) -> String {
        (source ?? summary)[key].map { String(describing: $0) } ?? "Not attached"
    }
    private var permission: [String: Any]? { summary["permission"] as? [String: Any] }

    private func build() {
        guard let content = window?.contentView else { return }
        let branding = walletStack([
            walletText("Algoria", size: 20, weight: .bold),
            walletText("Your agent. Your approval.", size: 12, color: .secondaryLabelColor),
        ], spacing: 2)
        let badge = walletText(preview ? "DESIGN PREVIEW · NO SIGNING" : "TEMPO · TESTNET", size: 11, weight: .semibold, color: walletAccent)
        let spacer = NSView()
        let header = walletStack([walletIcon("square.stack.3d.up.fill", description: "Algoria"), branding, spacer, badge], horizontal: true)
        branding.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentHuggingPriority(.required, for: .horizontal)

        let hero = WalletSurface(tint: true)
        var heroViews: [NSView]
        if kind == .permission {
            heroViews = [walletText(summary["replacement"] is String ? "Update spending permission" : "Set a spending permission", size: 15, weight: .semibold),
                         walletText("\(value("total"))", size: 36, weight: .bold, color: walletAccent),
                         walletText("test PathUSD · lifetime budget", color: .secondaryLabelColor),
                         walletText("No payment now. Every purchase still needs Touch ID.", size: 12)]
        } else {
            let amount = (summary["amount"] as? String).flatMap(Double.init).map { String(format: "%.6f", $0 / 1e6) } ?? "0.000001"
            heroViews = [walletText(summary["prompt"] == nil ? "Signing proof · self-transfer" : "Generate one image", size: 15, weight: .semibold),
                         walletText(amount, size: 36, weight: .bold, color: walletAccent),
                         walletText("test PathUSD · \(summary["prompt"] == nil ? "to your temporary account" : "Algoria image service")", color: .secondaryLabelColor),
                         walletText("Testnet tokens have no monetary value. Network fee is separate.", size: 12)]
        }
        walletPin(walletStack(heroViews, spacing: 6), to: hero, inset: 20)

        pageLabels = kind == .permission ? ["Overview", "Scope", "Limits & safety"] : ["Review", "Wallet", "Permission", "Activity"]
        selector = NSSegmentedControl(labels: pageLabels, trackingMode: .selectOne, target: self, action: #selector(changePage(_:)))
        selector.segmentStyle = .rounded
        selector.selectedSegment = 0
        selector.setAccessibilityLabel("Wallet details")
        let segmentWidth = ((window?.contentView?.frame.width ?? 740) - 60) / CGFloat(pageLabels.count)
        for i in pageLabels.indices { selector.setWidth(segmentWidth, forSegment: i) }
        pages = kind == .permission ? permissionPages() : purchasePages()
        showPage(0)

        let divider = NSBox(); divider.boxType = .separator
        expiryLabel = walletText(preview ? "No keys, funding or network requests." : "Review first. Authenticate next.", size: 11, color: .secondaryLabelColor)
        let security = walletStack([
            walletText(preview ? "Preview only" : "Protected by Touch ID", size: 13, weight: .semibold),
            expiryLabel,
        ], spacing: 3)
        approveButton = NSButton(title: preview ? "Close preview" : "Approve with Touch ID", target: self, action: #selector(approve(_:)))
        approveButton.bezelStyle = .rounded
        approveButton.controlSize = .large
        approveButton.bezelColor = walletAccent
        // No Return default: opening a window must not imply spending approval.
        approveButton.keyEquivalent = ""
        approveButton.setAccessibilityHelp(preview ? "Closes this preview without signing." : "Approves this exact request, then asks for Touch ID to sign.")
        cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel(_:)))
        cancelButton.bezelStyle = .rounded
        cancelButton.controlSize = .large
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityHelp("Close without returning a signed request.")
        let footer = walletStack([walletIcon("touchid", description: "Touch ID protection", size: 22), security,
                                  NSView(), cancelButton, approveButton], spacing: 12, horizontal: true)
        let root = walletStack([header, hero, selector, pageHost, divider, footer], spacing: 18)
        walletPin(root, to: content, inset: 24)
        pageHost.setContentHuggingPriority(.defaultLow, for: .vertical)
        pageHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
        window?.initialFirstResponder = cancelButton
        updateExpiry()
    }

    private func updateExpiry(now: Date = Date()) {
        guard !preview, let date = ISO8601DateFormatter().date(from: value("expires")) else { return }
        let seconds = Int(ceil(date.timeIntervalSince(now)))
        approveButton.isEnabled = seconds > 0
        if seconds <= 0 {
            expiryLabel.stringValue = "Expired. Cancel and request a fresh review."
            expiryLabel.textColor = .systemRed
            approveButton.title = "Request expired"
        } else if kind == .purchase {
            expiryLabel.stringValue = "Expires in \(seconds / 60)m \(seconds % 60)s · nothing signed yet"
            expiryLabel.textColor = seconds < 60 ? .systemOrange : .secondaryLabelColor
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
        let prompt = summary["prompt"] as? String ?? "Transfer one micro-unit back to this same temporary account."
        let promptView: NSView
        if prompt.count > 260 {
            let scroll = scrollPage([walletText(prompt, size: 14)])
            scroll.heightAnchor.constraint(equalToConstant: 100).isActive = true
            scroll.setAccessibilityLabel("Full request · scroll to read")
            promptView = scroll
        } else { promptView = walletText(prompt, size: 14) }
        let review = scrollPage([
            walletCard("Request", [promptView,
                                   walletRow("Valid until", walletDate(value("expires")))]),
            walletCard("Payment destination", [walletRow("Recipient · full address", value(summary["recipient"] == nil ? "address" : "recipient"), mono: true),
                                               walletRow("Network", value("network"))]),
            walletCard("What approval means", [walletText("Touch ID signs only this exact transaction. The plugin may then submit it. Cancel now to return no signed payment.", size: 12),
                                               walletText("A submitted payment cannot be undone by closing this window.", size: 12, color: .secondaryLabelColor)]),
        ])
        let wallet = scrollPage([
            walletCard("Temporary testnet wallet", [walletText("A disposable Secure Enclave key is used for this request. It is discarded when this process exits. Your existing wallet is never opened.", size: 13),
                                                    walletRow("Account · full address", value("address"), mono: true),
                                                    walletText("Never send real funds here. Any remaining test tokens are abandoned.", size: 12, color: .secondaryLabelColor)]),
            walletCard("Asset & fee bounds", [walletRow("Token contract · test PathUSD", value("token"), mono: true),
                                              walletRow("Gas limit", value("gasLimit")),
                                              walletRow("Maximum fee per gas · protocol units", value("maxFeePerGas")),
                                              walletText("These are upper bounds, not a final fee quote. Faucet funding is requested separately by the runner; this review does not fund the wallet.", size: 12, color: .secondaryLabelColor)]),
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
            walletText("Every purchase still needs Touch ID. This is not on-chain enforcement or full ERC-8196 compliance. No remaining balance is claimed here.", size: 12, color: .secondaryLabelColor)]))
        let activity = scrollPage([
            walletCard("Awaiting your approval", [walletRow("Current job", summary["jobId"] == nil ? "Signing proof" : value("jobId"), mono: true),
                                                   walletText("This is the current request, not a complete wallet history. No signed transaction has been returned yet.", size: 12)]),
            walletCard("If the flow is interrupted", [walletText("Resume the same saved job. The plugin keeps receipts and recovery state locally. Do not start a new payment to fix a missing image preview.", size: 13),
                                                      walletText("Revocation stops future local dispatches. It cannot undo a submitted payment or erase an uncertain reservation.", size: 12, color: .secondaryLabelColor)]),
        ])
        return [review, wallet, scrollPage(permissionCards), activity]
    }

    private func permissionPages() -> [NSView] {
        let overview = scrollPage([
            walletCard("Spending limits", [walletRow("Budget", value("budget")),
                                          walletRow("Maximum per purchase", "\(value("perCall")) test PathUSD"),
                                          walletRow("Expires", walletDate(value("expires"))),
                                          walletText("Updating a permission preserves spent amounts and uncertain reservations. The lifetime cap is not your available balance.", size: 12, color: .secondaryLabelColor)]),
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
                                             walletText("Revocation cannot undo a submitted payment, a signature already returned, or a dispatch already saved for recovery.", size: 12, color: .secondaryLabelColor)]),
        ])
        return [overview, scope, safety]
    }

    func showPage(_ index: Int) {
        guard pages.indices.contains(index) else { return }
        pageHost.subviews.forEach { $0.removeFromSuperview() }
        walletPin(pages[index], to: pageHost)
        selectedPage = index
        selector?.selectedSegment = index
        pageHost.setAccessibilityLabel(pageLabels[index])
    }
    @objc private func changePage(_ sender: NSSegmentedControl) { showPage(sender.selectedSegment) }
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
        window?.orderOut(nil)
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
        window.orderOut(nil)
        return approved
    }

    // Explicit fixture modes never reach key creation, SDK signing, or RPC.
    static func fixture(_ kind: WalletReviewKind, longPrompt: Bool = false) -> [String: Any] {
        let policy: [String: Any] = ["id": "00000000-0000-0000-0000-000000000001", "budget": "demo-images", "agent": "codex",
            "total": "5.000000", "perCall": "0.100000", "expires": "2030-10-05T18:30:00Z"]
        let scope: [String: Any] = ["network": "Tempo Moderato (42431)", "token": "0x20c0000000000000000000000000000000000000",
            "recipient": "0x1111111111111111111111111111111111111111"]
        if kind == .permission {
            return scope.merging(policy) { _, new in new }.merging(["policyId": policy["id"]!, "service": "image.generate",
                "resource": "https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate"]) { _, new in new }
        }
        return scope.merging(["prompt": longPrompt ? String(repeating: "A quiet Japanese garden with warm morning light. ", count: 80) : "A quiet Japanese garden with warm morning light, soft mist and a small wooden bridge. Editorial photography, natural colours.",
            "amount": "10000", "address": "0x2222222222222222222222222222222222222222", "gasLimit": "1000000",
            "maxFeePerGas": "20000000000", "expires": "2030-10-05T18:30:00Z", "permission": policy,
            "jobId": "00000000-0000-0000-0000-000000000002"]) { _, new in new }
    }

    static func renderPreviews(to directory: String) throws -> [String] {
        guard directory.hasPrefix("/"), FileManager.default.fileExists(atPath: directory) else { throw fail("PREVIEW_DIRECTORY_REQUIRED") }
        var paths: [String] = []
        for dark in [false, true] {
            for kind in [WalletReviewKind.purchase, .permission] {
                let controller = WalletReviewController(summary: fixture(kind), kind: kind, preview: true)
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
                    let name = "\(kind == .purchase ? "purchase" : "budget")-\(index)-\(dark ? "dark" : "light").png"
                    let path = URL(fileURLWithPath: directory).appendingPathComponent(name)
                    try png.write(to: path, options: .atomic)
                    paths.append(path.path)
                }
                controller.window?.close()
            }
        }
        return paths
    }

    static func selfTest() throws -> [String: Any] {
        for kind in [WalletReviewKind.purchase, .permission] {
            let controller = WalletReviewController(summary: fixture(kind, longPrompt: true), kind: kind, preview: true)
            controller.window?.contentView?.layoutSubtreeIfNeeded()
            for index in controller.pages.indices { controller.showPage(index) }
            guard !controller.approved, controller.selectedPage == controller.pages.count - 1,
                  controller.cancelButton.keyEquivalent == "\u{1b}", controller.approveButton.keyEquivalent.isEmpty,
                  controller.window?.initialFirstResponder === controller.cancelButton else { throw fail("UI_SAFETY_FAILED") }
            controller.approve(nil)
            guard !controller.approved else { throw fail("PREVIEW_APPROVAL_FAILED") }
            controller.window?.close()
            let live = WalletReviewController(summary: fixture(kind), kind: kind)
            live.approve(nil)
            guard live.approved else { throw fail("UI_APPROVAL_FAILED") }
            live.cancel(nil)
            guard !live.approved else { throw fail("UI_CANCEL_FAILED") }
            _ = live.windowShouldClose(live.window!)
            guard !live.approved else { throw fail("UI_CLOSE_FAILED") }
            live.window?.close()
            var expired = fixture(kind)
            expired["expires"] = "2020-01-01T00:00:00Z"
            let stale = WalletReviewController(summary: expired, kind: kind)
            stale.approve(nil)
            guard !stale.approved, !stale.approveButton.isEnabled else { throw fail("UI_EXPIRED_APPROVAL_FAILED") }
            stale.window?.close()
        }
        return ["status": "ui-self-test-passed", "keyCreated": false, "signed": false, "networkRequests": false]
    }
}
