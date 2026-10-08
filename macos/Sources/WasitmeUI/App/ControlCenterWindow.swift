import AppKit
import SwiftUI
import WasitmeCore

/// The Control Center as a normal Mac window: a standard title bar with a unified toolbar (draggable, double-click zooms
/// or minimizes as System Settings says, full screen works), a native sidebar (the pages with SF Symbols, the agent
/// picker, "Local only · updated …"), and the canvas beside it showing only the page (`view.chrome = "content"`). No
/// `.fullSizeContentView`: the web view never sits under the title bar, so nothing it draws can take the title bar's
/// clicks or be mistaken for the window buttons.
@MainActor
enum ControlCenterWindow {
    static let autosaveName = "\(WasitmeIdentity.bundleIdentifier).controlcenter"
    static let splitAutosaveName = "\(WasitmeIdentity.bundleIdentifier).controlcenter.split"
    static let styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]

    /// The smallest content area (below the toolbar): the canvas column at its minimum next to the widest sidebar, and the
    /// design's minimum height.
    static var minimumContentSize: CGSize {
        let c = theme.chrome
        return CGSize(width: max(theme.metrics.controlCenterMinimum.width, c.sidebarMaximum + c.contentMinimum),
                      height: theme.metrics.controlCenterMinimum.height)
    }

    /// Builds the window without showing it (no ordering, no activation), so tests can check it headless.
    /// `forCapture`: the offscreen `--capture` copy. It is never ordered in either, keeps no frame or sidebar width in the
    /// user's defaults, and gets its backing store at once so the frame view (title bar, toolbar) can be drawn into a bitmap.
    static func make(model: ControlCenterModel, content: ControlCenterContentView, toolbar: ControlCenterToolbar,
                     reduceMotion: Bool, forCapture: Bool = false) -> (window: NSWindow, split: ControlCenterSplitController) {
        let size = theme.metrics.controlCenter
        let split = ControlCenterSplitController(model: model, content: content, autosave: !forCapture)
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: styleMask, backing: .buffered,
                         defer: !forCapture)
        w.contentViewController = split
        w.titleVisibility = .visible
        w.titlebarAppearsTransparent = false
        w.toolbarStyle = .unified
        let bar = NSToolbar(identifier: ControlCenterToolbar.identifier)
        bar.delegate = toolbar
        bar.displayMode = .iconOnly
        bar.allowsUserCustomization = false
        w.toolbar = bar
        w.setContentSize(size)                    // after the toolbar: the page gets the designed size below it
        w.tabbingMode = .disallowed               // no "Show Tab Bar" items: one Control Center window
        w.collectionBehavior = [.fullScreenPrimary]
        w.contentMinSize = minimumContentSize
        w.isReleasedWhenClosed = false
        w.backgroundColor = theme.palette.sheet.nsColor
        w.animationBehavior = theme.motion.windowAnimation(reduceMotion: reduceMotion)
        apply(model: model, to: w)
        w.center()
        if !forCapture { w.setFrameAutosaveName(autosaveName) }
        return (w, split)
    }

    /// The page title in the toolbar, the agent under it. The Window menu and VoiceOver read the same.
    static func apply(model: ControlCenterModel, to window: NSWindow) {
        window.title = model.page.title
        window.subtitle = model.display.agents.count > 0 ? (model.selectedAgent?.name ?? "") : ""
    }
}

/// Sidebar + canvas. Collapsing the sidebar (toolbar button, View menu, ⌃⌘S) is instant while Reduce Motion is on.
@MainActor
final class ControlCenterSplitController: NSSplitViewController {
    let sidebarItem: NSSplitViewItem
    let contentItem: NSSplitViewItem
    var reduceMotion: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    init(model: ControlCenterModel, content: ControlCenterContentView, autosave: Bool = true) {
        let sidebar = NSHostingController(rootView: ControlCenterSidebar(model: model))
        sidebar.sizingOptions = []                // the split view sizes it
        // The split view starts from its items' current widths (an autosaved width, once there is one, wins).
        let size = theme.metrics.controlCenter
        sidebar.view.frame = NSRect(x: 0, y: 0, width: theme.chrome.sidebarIdeal, height: size.height)
        content.frame = NSRect(x: 0, y: 0, width: size.width - theme.chrome.sidebarIdeal, height: size.height)
        sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sidebarItem.minimumThickness = theme.chrome.sidebarMinimum
        sidebarItem.maximumThickness = theme.chrome.sidebarMaximum
        sidebarItem.canCollapse = true           // a sidebar item holds its width; window resizes go to the canvas
        contentItem = NSSplitViewItem(viewController: CanvasPaneController(content: content))
        contentItem.minimumThickness = theme.chrome.contentMinimum
        super.init(nibName: nil, bundle: nil)
        splitView.isVertical = true
        splitView.dividerStyle = .thin
        if autosave { splitView.autosaveName = ControlCenterWindow.splitAutosaveName }
        addSplitViewItem(sidebarItem)
        addSplitViewItem(contentItem)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not used") }

    override func toggleSidebar(_ sender: Any?) {
        guard reduceMotion() else { return super.toggleSidebar(sender) }
        sidebarItem.isCollapsed.toggle()            // not through the animator: no motion
    }
}

/// The canvas column: the content view that holds the locked-down web view.
@MainActor
final class CanvasPaneController: NSViewController {
    let content: ControlCenterContentView

    init(content: ControlCenterContentView) {
        self.content = content
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() { view = content }
}

/// The native sidebar: agent picker (when there are two or more agents), the pages, and the quiet footer.
struct ControlCenterSidebar: View {
    let model: ControlCenterModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.display.agents.count > 1 {
                Picker(selection: Binding(get: { model.selectedAgent?.id ?? "" }, set: { model.agentID = $0 })) {
                    ForEach(model.display.agents) { a in Text(verbatim: a.name).tag(a.id) }
                } label: {
                    Text(verbatim: "Agent")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, theme.spacing.s3)
                .padding(.top, theme.spacing.s3)
                .padding(.bottom, theme.spacing.s1)
            }
            List(selection: Binding<ControlCenterPage?>(get: { model.page }, set: { if let p = $0 { model.page = p } })) {
                ForEach(ControlCenterPage.allCases) { page in
                    Label { Text(verbatim: page.title) } icon: { theme.chrome.icon(for: page) }
                        .tag(page)
                }
            }
            .listStyle(.sidebar)
            Text(verbatim: model.sidebarFooter)
                .font(theme.chrome.footerFont)
                .foregroundStyle(theme.chrome.footerStyle)
                .lineLimit(2)
                .padding(.horizontal, theme.spacing.s4)
                .padding(.vertical, theme.spacing.s3)
        }
    }
}

/// The unified toolbar: the sidebar toggle before the page title (a navigational item, so it leads), then Check Again,
/// Open as Markdown and Copy Report at the trailing end. The app's items send their actions to `target` (the Control
/// Center controller), which validates them; the sidebar toggle goes up the responder chain to the split view controller.
/// No `.sidebarTrackingSeparator`: it only lines up with the sidebar in a full-size-content window, which this one is not
/// (the title bar must stay a plain, draggable strip with no web content under it).
@MainActor
final class ControlCenterToolbar: NSObject, NSToolbarDelegate {
    static let identifier = NSToolbar.Identifier("\(WasitmeIdentity.bundleIdentifier).controlcenter.toolbar")
    static let sidebar = NSToolbarItem.Identifier("sidebar")
    static let checkAgain = NSToolbarItem.Identifier("checkAgain")
    static let openMarkdown = NSToolbarItem.Identifier("openMarkdown")
    static let copyReport = NSToolbarItem.Identifier("copyReport")
    static let items: [NSToolbarItem.Identifier] = [sidebar, .flexibleSpace, checkAgain, openMarkdown, copyReport]

    weak var target: AnyObject?

    init(target: AnyObject?) {
        self.target = target
        super.init()
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch id {
        case Self.sidebar:
            let toggle = item(id, label: "Sidebar", tip: "Show or hide the sidebar (⌃⌘S)", symbol: theme.chrome.sidebarSymbol,
                              action: #selector(NSSplitViewController.toggleSidebar(_:)))
            toggle.target = nil                  // the responder chain: the window's split view controller
            toggle.isNavigational = true
            return toggle
        case Self.checkAgain:
            return item(id, label: "Check Again", tip: "Check again now (⌘R)", symbol: theme.chrome.checkAgainSymbol,
                        action: #selector(ControlCenterController.checkAgain(_:)))
        case Self.openMarkdown:
            return item(id, label: "Open as Markdown", tip: "Open the evidence report as Markdown",
                        symbol: theme.chrome.openMarkdownSymbol, action: #selector(ControlCenterController.openMarkdown(_:)))
        case Self.copyReport:
            return item(id, label: "Copy Report", tip: "Copy the evidence report (⇧⌘C)", symbol: theme.chrome.copyReportSymbol,
                        action: #selector(ControlCenterController.copyReport(_:)))
        default:
            return nil                           // the system's own items (flexible space)
        }
    }

    private func item(_ id: NSToolbarItem.Identifier, label: String, tip: String, symbol: String, action: Selector) -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: id)
        item.label = label
        item.paletteLabel = label
        item.toolTip = tip
        item.image = theme.chrome.image(symbol, label: label)
        item.isBordered = true
        item.target = target
        item.action = action
        return item
    }
}
