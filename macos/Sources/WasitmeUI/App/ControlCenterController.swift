import AppKit
import Observation
import WasitmeCore

/// The Control Center window (ControlCenterWindow.swift): native title bar, unified toolbar and sidebar around the
/// locked-down canvas, which shows only the page. Opened only by the user (popover "Open wasitme", the status menu,
/// Settings… / a page in the main menu, a hand-off from a second launch). Also the target of the app's own menu
/// commands (MainMenu.swift) and toolbar items, which it validates.
@MainActor
final class ControlCenterController: NSObject, NSWindowDelegate, NSMenuItemValidation, NSToolbarItemValidation {
    private let controller: AppController
    private let assets: CanvasAssetSource
    private let exporter: ReportExporter
    private let home: WasitmeDirectory
    private let launchAtLogin: LaunchAtLoginSwitch
    private var window: NSWindow?
    private var split: ControlCenterSplitController?
    private var toolbar: ControlCenterToolbar?
    private var model: ControlCenterModel?
    private var content: ControlCenterContentView?
    private var canvas: CanvasWebView?
    private lazy var presenter = WindowAlertPresenter(window: { [weak self] in self?.window })
    private lazy var guarded = GuardedActionFlow(performer: performer, presenter: presenter)
    private let performer: any GuardedActionPerforming
    /// The Settings page's backend (what is installed, the changes it runs); nil: every change is "not available".
    private let settings: SettingsPerformer?
    private let desktopPanel: (any DesktopPanelControlling)?
    /// The switch's state as last read (SMAppService is asked when the window opens or comes forward, and after a flip;
    /// not on every render).
    private var launchState: LaunchAtLoginState = .unavailable
    /// When the installer was last asked what is installed (monotonic), so coming forward does not ask every time.
    private var settingsReadAt: UInt64?
    private var lastPage: ControlCenterPage?
    /// The canvas could not be brought up (CanvasWebView.loadError): its place shows a message, and the next `show`
    /// tries once more with a fresh web view.
    private var canvasFailed = false
    private var renderGeneration = 0
    private var motionObserver: NSObjectProtocol?

    init(controller: AppController, assets: CanvasAssetSource, exporter: ReportExporter, home: WasitmeDirectory,
         launchAtLogin: LaunchAtLoginSwitch, settings: SettingsPerformer? = nil,
         desktopPanel: (any DesktopPanelControlling)? = nil) {
        self.controller = controller
        self.assets = assets
        self.exporter = exporter
        self.home = home
        self.launchAtLogin = launchAtLogin
        self.settings = settings
        self.desktopPanel = desktopPanel
        self.performer = settings ?? NotWiredPerformer()
        super.init()
        settings?.onChange = { [weak self] in
            self?.scheduleRender()
            self?.reportFinishedUpdate()
        }
        desktopPanel?.onVisibilityChange = { [weak self] in self?.scheduleRender() }
    }

    var isOpen: Bool { window?.isVisible == true }

    func show(page: ControlCenterPage?) {
        prepare(page: page)
        // An accessory app has no Dock icon and cannot easily take focus: be a regular app while the window
        // is open, back to accessory when it closes. Only ever on the user's own click.
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    private func prepare(page: ControlCenterPage?) {
        if window == nil {
            build()
        } else if canvasFailed {
            canvasFailed = false
            Task { await attachCanvas(size: theme.metrics.controlCenter) }
        }
        if let page { model?.page = page }
        refreshLaunchState()
        refreshSettings(force: page == .settings)
    }

    private func build() {
        let size = theme.metrics.controlCenter
        let model = ControlCenterModel(display: controller.controlCenterDisplay, snapshot: controller.shownSnapshot)
        let content = ControlCenterContentView(size: size)
        content.onAppearanceChange = { [weak self] in self?.scheduleRender() }
        let toolbar = ControlCenterToolbar(target: self)
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let (w, split) = ControlCenterWindow.make(model: model, content: content, toolbar: toolbar, reduceMotion: reduce)
        w.delegate = self
        self.window = w
        self.split = split
        self.toolbar = toolbar
        self.model = model
        self.content = content
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.window?.animationBehavior = theme.motion.windowAnimation(
                    reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
            }
        }
        observe()
        Task { await attachCanvas(size: size) }
    }

    private func attachCanvas(size: CGSize) async {
        guard let canvas = await CanvasWebView.make(assets: assets, size: size) else {
            content?.setCanvas(CanvasPlaceholderView(message: "The Control Center canvas could not be locked down, so it isn't shown."))
            return
        }
        canvas.onDecision { [weak self] in self?.handle($0) }
        // The page could not be brought up (a load that failed, or a web content process that kept stopping): say so where
        // the canvas was, instead of a blank view. Closing and reopening the window tries once more.
        canvas.onLoadError = { [weak self] _ in
            guard let self else { return }
            // Keep the failed CanvasWebView until the retry replaces it: this runs inside one of its web view's own
            // delegate callbacks, which is no place to release that web view.
            self.canvasFailed = true
            self.content?.setCanvas(CanvasPlaceholderView(
                message: "The Control Center canvas stopped and couldn't be brought back, so it isn't shown. Close this window and open wasitme again to try once more."))
        }
        self.canvas = canvas
        content?.setCanvas(canvas.webView)
        canvas.load()
    }

    /// Keeps the model in step with the store, the title bar with the model, and re-renders the canvas when what it shows
    /// changes.
    private func observe() {
        withObservationTracking {
            guard let model else { return }
            model.display = controller.controlCenterDisplay
            model.snapshot = controller.shownSnapshot
            model.scanning = controller.isScanning
            _ = controller.store.now
            if let id = model.agentID, !model.display.agents.contains(where: { $0.id == id }) { model.agentID = model.display.primary?.id }
            _ = (model.page, model.agentID)
            if model.page != lastPage {
                lastPage = model.page
                refreshSettings(force: true)
            }
            if let window { ControlCenterWindow.apply(model: model, to: window) }
            scheduleRender()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observe() }
        }
    }

    private func scheduleRender() {
        renderGeneration += 1
        let generation = renderGeneration
        Task { @MainActor [weak self] in
            guard let self, generation == self.renderGeneration else { return }
            await self.render()
        }
    }

    private func render() async {
        guard let canvas, canvas.isReady, let model, let window else { return }
        let dark = window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let view = BridgePolicy.viewArgument(display: model.display, page: model.page, agentID: model.agentID, dark: dark,
                                             now: controller.store.now, timeZone: .current, launchAtLogin: launchState,
                                             settings: settingsState)
        _ = try? await canvas.render(snapshot: model.snapshot, view: view)
    }

    /// `view.settings`: what the installer last said, the panel, the login switch and what is running now.
    private var settingsState: SettingsState {
        let panel = desktopPanel?.isVisible ?? false
        return settings?.state(desktopPanel: panel, launchAtLogin: launchState)
            ?? SettingsState(status: .unknown, desktopPanel: panel, launchAtLogin: launchState, canClearHistory: false)
    }

    private lazy var routes = ControlCenterRoutes(
        render: { [weak self] in self?.scheduleRender() },
        scanNow: { [weak self] in self?.controller.scanNow() },
        showPage: { [weak self] page in self?.model?.page = page },
        selectAgent: { [weak self] id in
            if self?.model?.display.agents.contains(where: { $0.id == id }) == true { self?.model?.agentID = id }
        },
        copyReport: { [weak self] in self?.copyReport(nil) },
        openMarkdown: { [weak self] in self?.openMarkdown(nil) },
        setLaunchAtLogin: { [weak self] on in self?.setLaunchAtLogin(on) },
        setDesktopPanel: { [weak self] on in self?.setDesktopPanel(on) },
        revealDataFolder: { [weak self] in self?.revealDataFolder() },
        guarded: { [weak self] action in
            Task { @MainActor [weak self] in await self?.guarded.handle(action) }
        })

    private func handle(_ decision: BridgeDecision) { routes.route(decision) }

    // MARK: Settings

    /// Asks the installer what is installed while the Settings page shows: on opening it, and on coming forward when the
    /// last answer is over 30 s old. After each change the performer asks again itself.
    private func refreshSettings(force: Bool) {
        guard let settings, model?.page == .settings else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        if !force, let at = settingsReadAt, now >= at, now - at < 30_000_000_000 { return }
        settingsReadAt = now
        Task { await settings.refresh() }
    }

    /// An update this app started ended while the app was quit (the installer quits and reopens it): say how it went,
    /// once, on this window.
    private func reportFinishedUpdate() {
        guard isOpen, window?.attachedSheet == nil, let settings, settings.running == nil,
              let report = settings.takeUnreportedUpdate() else { return }
        presenter.inform(report.text, detail: report.detail)
    }

    /// The desktop panel switch: shows or hides it now (the panel says so itself through `onVisibilityChange`).
    private func setDesktopPanel(_ on: Bool) {
        guard let desktopPanel else { return }
        if on { desktopPanel.show() } else { desktopPanel.hide() }
        scheduleRender()
    }

    /// "Show in Finder": selects `~/.wasitme` in Finder (only on the user's click). Not there yet: says so.
    private func revealDataFolder() {
        guard let url = DataFolder.revealable(home) else {
            presenter.inform("Nothing saved yet", detail: "wasitme hasn't saved any history on this Mac yet.")
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    // MARK: launch at login

    private func refreshLaunchState() {
        let state = launchAtLogin.state
        if state != launchState {
            launchState = state
            scheduleRender()
        }
    }

    /// The Settings switch: flips it, re-renders the page with what is true now, and explains anything that isn't a
    /// plain on/off (approval needed, the installer's LaunchAgent already does it, not available, refused).
    private func setLaunchAtLogin(_ on: Bool) {
        let outcome = launchAtLogin.set(on)
        launchState = outcome.state
        scheduleRender()
        if let sheet = LaunchAtLoginSheet.after(outcome) { presenter.show(sheet) }
    }

    // MARK: commands (toolbar, main menu)

    @objc func checkAgain(_ sender: Any?) { controller.scanNow() }

    @objc func copyReport(_ sender: Any?) {
        let agent = model?.selectedAgent?.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            if case .failure(let e) = await self.exporter.copy(agentID: agent) { self.presenter.inform(e.message, detail: nil) }
        }
    }

    @objc func openMarkdown(_ sender: Any?) {
        let agent = model?.selectedAgent?.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            if case .failure(let e) = await self.exporter.openMarkdown(agentID: agent) { self.presenter.inform(e.message, detail: nil) }
        }
    }

    @objc func showPageFromMenu(_ sender: Any?) {
        guard let tag = (sender as? NSMenuItem)?.tag, ControlCenterPage.allCases.indices.contains(tag) else { return }
        show(page: ControlCenterPage.allCases[tag])
    }

    @objc func showSettings(_ sender: Any?) { show(page: .settings) }

    /// Show / Hide Sidebar (toolbar, View menu, ⌃⌘S) whatever has focus. The split view controller gets it first when
    /// focus is inside the window's views; when the window itself is the first responder, the chain goes window →
    /// delegate (this controller) and would skip the split view controller, so it is forwarded from here.
    @objc func toggleSidebar(_ sender: Any?) { split?.toggleSidebar(sender) }

    @objc func showAbout(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: AboutPanel.options())
        NSApp.activate()
    }

    @objc func openReadme(_ sender: Any?) { openHelp(.readme) }
    @objc func openMethod(_ sender: Any?) { openHelp(.method) }

    /// Opens the installed copy in the default app for Markdown; else says where it is. Never fetches anything.
    private func openHelp(_ doc: HelpDoc) {
        if let url = doc.installedCopy(home: home), NSWorkspace.shared.open(url) { return }
        let (text, detail) = doc.whereItIs(home: home)
        if window?.isVisible == true {
            presenter.inform(text, detail: detail)
        } else {
            let alert = NSAlert()
            alert.messageText = text
            alert.informativeText = detail
            alert.addButton(withTitle: "OK")
            NSApp.activate()
            alert.runModal()
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(showPageFromMenu(_:)) {
            let on = isOpen && ControlCenterPage.allCases.indices.contains(item.tag) && model?.page == ControlCenterPage.allCases[item.tag]
            item.state = on ? .on : .off
            return true
        }
        if item.action == #selector(toggleSidebar(_:)) {
            item.title = split?.sidebarItem.isCollapsed == true ? "Show Sidebar" : "Hide Sidebar"
            return isOpen
        }
        if item.action == #selector(openMethod(_:)) {
            // Release copies carry the README but not docs/ (scripts/release.sh): no item that only says "not here".
            item.isHidden = !HelpDoc.method.isShown(home: home)
            return !item.isHidden
        }
        return validate(item.action)
    }

    func validateToolbarItem(_ item: NSToolbarItem) -> Bool { validate(item.action) }

    private func validate(_ action: Selector?) -> Bool {
        switch action {
        case #selector(checkAgain(_:)): return !controller.isScanning
        case #selector(copyReport(_:)), #selector(openMarkdown(_:)): return isOpen && model?.hasReport == true
        default: return true
        }
    }

    // MARK: window

    func windowDidBecomeKey(_ notification: Notification) {
        refreshLaunchState()
        refreshSettings(force: false)
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}
