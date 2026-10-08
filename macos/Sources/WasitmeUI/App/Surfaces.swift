import AppKit
import Observation
import SwiftUI
import WasitmeCore

/// Puts a `GlanceDisplay` on a menu bar button: the template glyph (the system tints it), "+n" beside it when the
/// timeline has new changes (DESIGN.md §6; never while out of date), dimming, and ONE string used as both the VoiceOver
/// label and the tooltip.
@MainActor
public enum StatusItemPresenter {
    public static func apply(_ d: GlanceDisplay, to button: NSButton, renderer: any GlyphRendering = Theme.current.glyphs,
                             glyphSize: CGFloat = Theme.current.menuBarGlyphSize) {
        let label = d.accessibilityLabel
        let image = renderer.menuBarImage(d.glyph, pointSize: glyphSize)
        image.accessibilityDescription = label
        button.image = image
        if d.newEventCount > 0 {
            button.font = theme.menuBarCountFont
            button.title = Tokens.FindingState.newChangesText(d.newEventCount)
            button.imagePosition = .imageLeading
        } else {
            button.title = ""
            button.imagePosition = .imageOnly
        }
        button.toolTip = label
        button.setAccessibilityLabel(label)
        if let bar = button as? NSStatusBarButton {
            bar.appearsDisabled = d.glyphDimmed
        } else {
            button.alphaValue = d.glyphDimmed ? theme.metrics.menuBarDimmedAlpha : 1
        }
    }
}

/// Live wrapper: SwiftUI observes the controller, the view renders the value.
struct LivePopover: View {
    let controller: AppController
    let actions: PopoverActions

    var body: some View {
        PopoverView(display: controller.display, scanning: controller.isScanning,
                    engineMessage: controller.isScanning ? nil : controller.lastEngineMessage, actions: actions)
    }
}

/// The menu bar drop-down: a borderless NSPanel under the status item, placed by the tested pure
/// `PanelPlacement`, closed by Escape, a click outside, or the status item again.
@MainActor
final class PopoverController {
    private let controller: AppController
    private let actions: PopoverActions
    private var panel: StatusPanel?
    private var outsideClickMonitor: Any?
    /// `ProcessInfo.systemUptime` at the last close: a monotonic clock, so a wall-clock step cannot leave
    /// the status item unresponsive.
    private var lastClose: TimeInterval = -.infinity
    private var resignObserver: NSObjectProtocol?

    init(controller: AppController, actions: PopoverActions) {
        self.controller = controller
        self.actions = actions
    }

    var isVisible: Bool { panel?.isVisible == true }

    func toggle(from button: NSStatusBarButton) {
        if isVisible {
            close()
        } else if ProcessInfo.processInfo.systemUptime - lastClose > 0.25 {    // the click that caused resign-key
            show(from: button)
        }
    }

    func show(from button: NSStatusBarButton) {
        guard let buttonWindow = button.window else { return }
        let panel = self.panel ?? build()
        let itemFrame = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let screens = NSScreen.screens.map {
            ScreenGeometry(frame: $0.frame, visibleFrame: $0.visibleFrame, topSafeAreaInset: $0.safeAreaInsets.top)
        }
        let placement = PanelPlacement.place(statusItemFrame: itemFrame, panelSize: theme.metrics.popover, screens: screens)
        panel.setFrame(placement.frame, display: true)
        panel.makeKeyAndOrderFront(nil)          // key, not active: the app never steals focus from the user's app
        button.highlight(true)
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }    // global monitors are delivered on the main thread
        }
    }

    func close() {
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
        if let monitor = outsideClickMonitor { NSEvent.removeMonitor(monitor); outsideClickMonitor = nil }
        lastClose = ProcessInfo.processInfo.systemUptime
        onClose()
    }

    var onClose: () -> Void = {}

    private func build() -> StatusPanel {
        let p = StatusPanel(size: theme.metrics.popover)
        p.contentView = NSHostingView(rootView: LivePopover(controller: controller, actions: actions))
        p.onCancel = { [weak self] in self?.close() }
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
        panel = p
        return p
    }
}

/// Desktop panel size, remembered per user (a view preference, not data).
@MainActor @Observable
final class DesktopPanelModel {
    var size: DesktopPanelSize {
        didSet {
            UserDefaults.standard.set(size.rawValue, forKey: Self.key)
            onSizeChange(size)
        }
    }
    @ObservationIgnored var onSizeChange: (DesktopPanelSize) -> Void = { _ in }
    static let key = "desktopPanelSize"
    init() { size = DesktopPanelSize(rawValue: UserDefaults.standard.string(forKey: Self.key) ?? "") ?? .medium }
}

struct LiveDesktopPanel: View {
    let controller: AppController
    let model: DesktopPanelModel
    let hide: () -> Void

    var body: some View {
        DesktopPanelView(display: controller.display, size: model.size)
            .contextMenu {
                Button("Small") { model.size = .small }
                Button("Medium") { model.size = .medium }
                Divider()
                Button("Hide desktop panel") { hide() }
            }
    }
}

/// The desktop panel: desktop-icon level + 1, on every Space, never key, never steals focus.
@MainActor
final class DesktopPanelController: DesktopPanelControlling {
    private let controller: AppController
    private let model = DesktopPanelModel()
    private var panel: DesktopPanel?

    init(controller: AppController) { self.controller = controller }

    var isVisible: Bool { panel?.isVisible == true }

    /// The Control Center's Settings switch follows the panel, wherever it was shown or hidden from.
    var onVisibilityChange: (() -> Void)?

    func toggle() { isVisible ? hide() : show() }

    func show() {
        let p = panel ?? build()
        p.orderFrontRegardless()                 // never activates the app
        onVisibilityChange?()
    }

    func hide() {
        panel?.orderOut(nil)
        onVisibilityChange?()
    }

    private func build() -> DesktopPanel {
        let p = DesktopPanel(size: model.size.size)
        let host = NSHostingView(rootView: LiveDesktopPanel(controller: controller, model: model, hide: { [weak self] in self?.hide() }))
        host.sizingOptions = []                  // the controller sizes the panel explicitly
        p.contentView = host
        if let screen = NSScreen.main?.visibleFrame {
            p.setFrameOrigin(NSPoint(x: screen.minX + theme.spacing.s6, y: screen.minY + theme.spacing.s6))
        }
        // Small/Medium from the context menu: resize in place, keeping the bottom-left corner where the user put it.
        model.onSizeChange = { [weak p] size in
            guard let p else { return }
            p.setFrame(NSRect(origin: p.frame.origin, size: size.size), display: true)
        }
        panel = p
        return p
    }
}
