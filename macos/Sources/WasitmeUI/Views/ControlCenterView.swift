import AppKit
import Observation
import SwiftUI
import WasitmeCore

/// What the Control Center shows. Observable so the canvas re-renders when it changes.
@MainActor @Observable
public final class ControlCenterModel {
    public var display: GlanceDisplay
    public var snapshot: Snapshot?
    public var page: ControlCenterPage
    public var agentID: String?
    public var scanning = false

    public init(display: GlanceDisplay, snapshot: Snapshot?, page: ControlCenterPage? = nil) {
        self.display = display
        self.snapshot = snapshot
        self.page = page ?? ControlCenterPage.landing(for: display.lead)
        self.agentID = display.primary?.id
    }

    public var selectedAgent: AgentDisplay? { display.agents.first { $0.id == agentID } ?? display.primary }

    /// The sidebar footer: "Checking…" while a check runs, else "Local only · updated 4 min ago".
    public var sidebarFooter: String { scanning ? "Checking…" : display.sidebarFooter }

    /// A report exists to copy or open: an agent is shown (current or last known).
    public var hasReport: Bool {
        (display.document == .ok || display.document == .stale) && selectedAgent != nil
    }
}

/// The Control Center's canvas column: the web view and nothing else. The window draws the chrome natively (title bar,
/// toolbar, sidebar with the pages, agent picker and footer: ControlCenterWindow.swift), so the canvas renders only the
/// page (`view.chrome = "content"`). Plain AppKit layout (no NSViewRepresentable), so `--capture` can put the web view's
/// own `takeSnapshot` image here.
@MainActor
public final class ControlCenterContentView: NSView {
    public private(set) var canvas: NSView

    init(size: CGSize) {
        canvas = CanvasPlaceholderView(message: "Loading…")
        super.init(frame: NSRect(origin: .zero, size: size))
        addSubview(canvas)
        layoutPieces()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not used") }

    public override var isFlipped: Bool { true }

    /// Light/dark switched while the window is open: the canvas is re-rendered with the new appearance.
    var onAppearanceChange: () -> Void = {}
    public override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange()
    }

    func setCanvas(_ view: NSView) {
        canvas.removeFromSuperview()
        canvas = view
        addSubview(view)
        layoutPieces()
    }

    public override func layout() {
        super.layout()
        layoutPieces()
    }

    private func layoutPieces() {
        canvas.frame = bounds
    }
}

/// Shown where the canvas goes while it loads or when it could not be created (fails closed).
final class CanvasPlaceholderView: NSHostingView<AnyView> {
    init(message: String) {
        super.init(rootView: AnyView(
            plain(message).typeStyle(theme.type.ui).ink(theme.palette.inkSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.palette.sheet.color)))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not used") }
    @MainActor required init(rootView: AnyView) { super.init(rootView: rootView) }
}
