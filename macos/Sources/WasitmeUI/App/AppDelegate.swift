import AppKit
import Observation
import WasitmeCore

/// The live app: status item + popover + desktop panel + Control Center, all reading one `GlanceStore`
/// through `AppController.display`.
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private let options: LaunchOptions
    private let controller: AppController
    private var statusItem: NSStatusItem?
    private var popover: PopoverController?
    private var desktop: DesktopPanelController?
    private var controlCenter: ControlCenterController?
    private var handOffObserver: NSObjectProtocol?
    private var memoryBaseline: MemoryProbe.Baseline?

    public init(options: LaunchOptions) {
        self.options = options
        controller = AppController(store: GlanceStore(directory: options.home), runner: EngineRunner(directory: options.home))
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // LSUIElement does this for the bundled app; explicit for an unbundled binary.
        NSApp.setActivationPolicy(.accessory)
        memoryBaseline = MemoryProbe.baseline()
        let actions = PopoverActions(
            openControlCenter: { [weak self] page in self?.openControlCenter(page) },
            scanNow: { [weak self] in self?.controller.scanNow() },
            toggleDesktopPanel: { [weak self] in self?.desktop?.toggle() },
            quit: { NSApp.terminate(nil) })
        popover = PopoverController(controller: controller, actions: actions)
        popover?.onClose = { [weak self] in self?.statusItem?.button?.highlight(false) }
        let desktop = DesktopPanelController(controller: controller)
        self.desktop = desktop
        // The Settings page's changes: the installer, uninstaller and engine of the folder this app reads, each run only
        // after a native confirmation. Removing the app quits it once the detached run has started.
        let settings = SettingsPerformer.make(
            directory: options.home, engine: controller.runner,
            quit: { NSApp.terminate(nil) },
            afterClear: { [weak self] in self?.controller.scanNow() })
        let controlCenter = ControlCenterController(
            controller: controller,
            assets: CanvasAssetSource.resolve(override: options.canvasDirectory),
            exporter: ReportExporter(source: EngineReportSource(runner: controller.runner)),
            home: options.home,
            launchAtLogin: LaunchAtLoginSwitch.make(service: SMAppServiceLaunchAtLogin()),
            settings: settings,
            desktopPanel: desktop)
        self.controlCenter = controlCenter
        // The main menu shows only while the Control Center is open (the app is a regular app then).
        MainMenu.install(target: controlCenter)
        installStatusItem()
        observeDisplay()
        controller.store.start()
        handOffObserver = DistributedNotificationCenter.default().addObserver(
            forName: SingleInstance.handOffNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.showPopover() }
        }
        scheduleMemoryReport()
    }

    /// Clicking the app (Finder, Spotlight, the Dock while the Control Center is open) brings the Control Center up.
    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openControlCenter(nil) }
        return true
    }

    public func applicationWillTerminate(_ notification: Notification) {
        controller.store.stop()
    }

    // MARK: status item

    private func installStatusItem() {
        // Variable length: "+n" new changes sits beside the glyph (DESIGN.md §6).
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.target = self
        item.button?.action = #selector(statusItemClicked(_:))
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        item.autosaveName = "\(WasitmeIdentity.bundleIdentifier).statusitem"
        statusItem = item
    }

    /// Right-click (or Control-click): the app's few commands, which the designed popover has no room for.
    private func showStatusMenu(from button: NSStatusBarButton) {
        popover?.close()
        let menu = NSMenu()
        let scan = NSMenuItem(title: controller.isScanning ? "Checking…" : "Check Again", action: #selector(menuScan), keyEquivalent: "")
        scan.isEnabled = !controller.isScanning
        menu.addItem(scan)
        menu.addItem(NSMenuItem(title: "Open wasitme", action: #selector(menuOpen), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: desktop?.isVisible == true ? "Hide Desktop Panel" : "Show Desktop Panel",
                                action: #selector(menuDesktop), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit wasitme", action: #selector(menuQuit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 4), in: button)
    }

    @objc private func menuScan() { controller.scanNow() }
    @objc private func menuOpen() { openControlCenter(nil) }
    @objc private func menuDesktop() { desktop?.toggle() }
    @objc private func menuQuit() { NSApp.terminate(nil) }

    /// Re-arms after every change. `onChange` may run off the main actor, so it only schedules a hop.
    private func observeDisplay() {
        withObservationTracking {
            if let button = statusItem?.button { StatusItemPresenter.apply(controller.display, to: button) }
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observeDisplay() }
        }
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        guard let button = statusItem?.button else { return }
        if let event = NSApp.currentEvent, event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            showStatusMenu(from: button)
        } else {
            popover?.toggle(from: button)
        }
    }

    private func showPopover() {
        guard let button = statusItem?.button, popover?.isVisible == false else { return }
        popover?.show(from: button)
    }

    private func openControlCenter(_ page: ControlCenterPage?) {
        popover?.close()
        controlCenter?.show(page: page)
    }

    // MARK: measurement hook (D48 memory budgets)

    /// `--memory-report FILE [--memory-report-after SEC]`: after SEC seconds of normal running, write the
    /// app's footprint (plus any WebKit helpers it started) to FILE. No UI, no effect on behaviour.
    private func scheduleMemoryReport() {
        guard let file = options.memoryReportFile else { return }
        let delay = options.memoryReportAfter
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            let label = (self?.controlCenterOpen ?? false) ? "control-center-open" : "idle"
            let report = MemoryProbe.report(label: label, since: self?.memoryBaseline)
            try? MemoryProbe.write([report], to: file)
        }
    }

    private var controlCenterOpen: Bool { NSApp.windows.contains { $0.isVisible && $0.styleMask.contains(.titled) } }
}

/// Entry point used by `main.swift`.
public enum AppMain {
    @MainActor
    public static func run(_ options: LaunchOptions) -> Never {
        let app = NSApplication.shared
        // The bundled IBM Plex faces (D57), before any view or font metric is touched.
        FontRegistry.registerBundledFonts()
        if let out = options.captureDirectory {
            // Offscreen only: no Dock icon, no menu bar item, no window is ever ordered in.
            app.setActivationPolicy(.prohibited)
            CaptureRunner.run(options: options, outputDirectory: out)
        }

        let bundleID = Bundle.main.bundleIdentifier ?? WasitmeIdentity.bundleIdentifier
        let lock = InstanceLock(url: SingleInstance.lockURL(bundleID: bundleID, home: options.home.url))
        let decision = SingleInstance.decide(lockAcquired: lock != nil,
                                             otherInstancePIDs: SingleInstance.otherInstances(bundleID: Bundle.main.bundleIdentifier))
        if decision == .handOff {
            SingleInstance.postHandOff()
            exit(0)
        }
        // NSApplication.delegate is WEAK: these locals live until `app.run()` returns (it never does).
        let delegate = AppDelegate(options: options)
        app.delegate = delegate
        withExtendedLifetime((lock, delegate)) { app.run() }
        exit(0)
    }
}
