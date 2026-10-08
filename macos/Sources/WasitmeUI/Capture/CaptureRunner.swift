import AppKit
import SwiftUI
import WasitmeCore
import WebKit

/// `WasitmeApp --capture DIR [--fixtures DIR] [--canvas DIR]`: renders every view for every golden in
/// `contract/fixtures/manifest.json` OFFSCREEN, in light and dark, writes PNGs plus `index.json`, and exits.
/// No window is ever ordered in, no status item is created, the app never activates (activation policy
/// `.prohibited`). This is how all visual verification is done (macos/README.md, "Offscreen capture").
///
/// AppKit/SwiftUI views are drawn with `cacheDisplay`; the canvas with `WKWebView.takeSnapshot` (cacheDisplay
/// doesn't draw WKWebView), composited into the web view's frame. The canvas also runs the S-WEB checks:
/// DOM marker set by app.js, inline-script canary blocked by the CSP header, remote fetch/image blocked,
/// navigation denied, a malformed bridge message rejected, a destructive request arriving only as a request.
///
/// Exit status: 0 all checks passed, 1 a check failed, 2 the fixtures could not be read.
@MainActor
public enum CaptureRunner {
    struct Manifest: Decodable {
        struct Expect: Decodable { let display: String; let lead: String }
        struct Entry: Decodable { let file: String; let contract: String; let valid: Bool; let now: String; let expect: Expect }
        let fixtures: [Entry]
    }

    public static func run(options: LaunchOptions, outputDirectory: URL) -> Never {
        Task { @MainActor in
            let code = await capture(options: options, out: outputDirectory)
            exit(code)
        }
        NSApplication.shared.run()       // WebKit needs the main run loop; policy is .prohibited (no UI)
        exit(2)
    }

    static let appearances: [(name: String, dark: Bool)] = [("light", false), ("dark", true)]

    static func capture(options: LaunchOptions, out: URL) async -> Int32 {
        let log = CaptureLog(out: out)
        guard let fixtures = options.fixturesDirectory ?? findFixtures() else {
            log.fail("contract/fixtures/manifest.json not found; pass --fixtures DIR")
            return 2
        }
        let manifest: Manifest
        do {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: fixtures.appendingPathComponent("manifest.json")))
        } catch {
            log.fail("cannot read the manifest or create the output directory: \(error)")
            return 2
        }
        let baseline = MemoryProbe.baseline()

        // 0. The bundled faces: SwiftUI falls back to the system font silently, so a missing face must fail here.
        let fonts = FontRegistry.registerBundledFonts()
        log.info["fonts"] = "\(fonts.registered) of \(FontRegistry.files.count) registered from \(fonts.directory ?? "nowhere")"
        log.check(FontRegistry.isRegistered, "fonts: every IBM Plex face the type scale names is registered")

        // Memory before anything is drawn (fonts registered, as the live app does at launch). The closest capture gets to
        // the D48 idle row: this process has no status item or file store, so the live `--memory-report` hook is the
        // real idle check.
        let idle = MemoryProbe.report(label: "capture: before any rendering (process idle)", since: nil)
        log.memory.append(idle)
        log.budget(MemoryBudget.idle(idle))

        // The canvas, opened as the shipping app opens the Control Center: the first shown snapshot golden rendered,
        // settled 3 s (as S-WEB measured), BEFORE any QA drawing: no native PNG and no takeSnapshot yet (D48: snapshots
        // are QA-only and inflate both processes).
        let size = theme.metrics.controlCenter
        let assets = CanvasAssetSource.resolve(override: options.canvasDirectory)
        log.info["canvas"] = assets.isPlaceholder ? "embedded placeholder" : "directory"
        let canvas = await CanvasWebView.make(assets: assets, size: size)
        var decisions: [BridgeDecision] = []
        if let canvas {
            canvas.onDecision { decisions.append($0) }
            canvas.load()
            log.check(await canvas.waitUntilReady(), "canvas: page loaded and posted ready")
            if let first = firstShownSnapshot(manifest, fixtures: fixtures) {
                let model = ControlCenterModel(display: first.display, snapshot: first.snapshot)
                let view = BridgePolicy.viewArgument(display: first.display, page: model.page, agentID: model.agentID, dark: false,
                                                     now: first.now, timeZone: .current)
                let result = try? await canvas.render(snapshot: first.snapshot, view: view)
                log.check(result as? String == "rendered", "\(first.slug): canvas render (memory steady state)")
                try? await Task.sleep(for: .seconds(3))
                let steady = MemoryProbe.report(label: "capture: Control Center steady state (\(first.slug) rendered, nothing drawn offscreen yet)",
                                                since: baseline)
                log.memory.append(steady)
                log.budget(MemoryBudget.controlCenter(steady))
            } else {
                log.fail("memory: no shown snapshot golden to open the Control Center with")
            }
        } else {
            log.fail("canvas: the content rule list could not be compiled (the canvas fails closed)")
        }

        // 1. Glyph sheets.
        for a in appearances {
            log.write(Offscreen.png(GlyphSheet(), size: GlyphSheet.size, dark: a.dark), "glyphs--\(a.name).png")
        }

        // 2. Native glance surfaces for every glance golden (tamper cases give mismatch/refused).
        var ccInputs: [(slug: String, display: GlanceDisplay, snapshot: Snapshot?, now: Date)] = []
        func glanceSurfaces(_ d: GlanceDisplay, _ slug: String) {
            for a in appearances {
                log.write(Offscreen.png(MenuBarPreview(display: d), size: MenuBarPreview.size, dark: a.dark), "\(slug)--menubar--\(a.name).png")
                log.write(Offscreen.png(PopoverView(display: d, actions: .inert), size: theme.metrics.popover, dark: a.dark), "\(slug)--popover--\(a.name).png")
                log.write(Offscreen.png(DesktopPanelView(display: d, size: .small), size: theme.metrics.panelSmall, dark: a.dark), "\(slug)--panel-small--\(a.name).png")
                log.write(Offscreen.png(DesktopPanelView(display: d, size: .medium), size: theme.metrics.panelMedium, dark: a.dark), "\(slug)--panel-medium--\(a.name).png")
            }
        }
        for entry in manifest.fixtures {
            let slug = entry.file.replacingOccurrences(of: ".json", with: "").replacingOccurrences(of: "/", with: "-")
            guard let data = try? Data(contentsOf: fixtures.appendingPathComponent(entry.file)),
                  let now = ContractDate.parse(entry.now) else {
                log.fail("\(entry.file): unreadable fixture"); continue
            }
            if entry.contract == "glance" {
                let (status, glance) = ContractFile.readGlance(data)
                let d = GlanceDisplay.make(status: status, glance: glance, now: now)
                log.check(d.document.rawValue == entry.expect.display, "\(entry.file): display \(d.document.rawValue), manifest \(entry.expect.display)")
                glanceSurfaces(d, slug)
                ccInputs.append((slug, d, nil, now))
            } else {
                let (status, snapshot) = ContractFile.readSnapshot(data)
                let d = GlanceDisplay.make(status: status, glance: snapshot?.glancePart, now: now)
                log.check(d.document.rawValue == entry.expect.display, "\(entry.file): display \(d.document.rawValue), manifest \(entry.expect.display)")
                ccInputs.append((slug, d, status == .ok ? snapshot : nil, now))
            }
        }
        // 2b. The app states no golden can produce (first read not finished, no status file, an unreadable one), made from
        //     the display rules alone, so every app glyph shows up in a capture next to the goldens' empty / mismatch / refused.
        let appNow = manifest.fixtures.first.flatMap { ContractDate.parse($0.now) } ?? Date(timeIntervalSince1970: 0)
        let appStatuses: [(slug: String, status: SourceStatus, expect: DocumentDisplay, glyph: MenuBarGlyph)] = [
            ("app-loading", .notLoaded, .loading, .loading),
            ("app-not-set-up", .missing, .notSetUp, .notSetUp),
            ("app-unreadable", .invalid("capture: synthetic unreadable file"), .unreadable, .error),
        ]
        for s in appStatuses {
            let d = GlanceDisplay.make(status: s.status, glance: nil, now: appNow)
            log.check(d.document == s.expect && d.glyph == s.glyph, "\(s.slug): display \(d.document.rawValue), glyph \(d.glyph)")
            glanceSurfaces(d, s.slug)
            ccInputs.append((s.slug, d, nil, appNow))
        }
        log.memory.append(MemoryProbe.report(label: "capture: native views rendered (QA only)", since: baseline))

        // 3. Control Center canvas column (the page only, `chrome: "content"`; the window's native chrome is checked by the
        //    WasitmeUITests window tests and a real window capture) for every golden.
        guard let canvas else { return log.finish() }
        for input in ccInputs {
            for a in appearances {
                let model = ControlCenterModel(display: input.display, snapshot: input.snapshot)
                let content = ControlCenterContentView(size: size)
                content.appearance = NSAppearance(named: a.dark ? .darkAqua : .aqua)
                content.setCanvas(canvas.webView)
                content.layoutSubtreeIfNeeded()
                let view = BridgePolicy.viewArgument(display: input.display, page: model.page, agentID: model.agentID, dark: a.dark,
                                                     now: input.now, timeZone: .current, launchAtLogin: .off, settings: sampleSettings)
                let result = try? await canvas.render(snapshot: input.snapshot, view: view)
                log.check(result as? String == "rendered", "\(input.slug) \(a.name): canvas render")
                let web = try? await canvas.webView.takeSnapshot(configuration: nil)
                log.write(Offscreen.composite(content, web: web, webFrame: canvas.webView.frame), "\(input.slug)--control-center--\(a.name).png")
            }
        }
        // 3b. The whole Control Center window (title bar, unified toolbar, native sidebar, the page), drawn offscreen.
        await windowCaptures(canvas, inputs: ccInputs, log: log)
        // 3c. The Settings confirmation sheets (NSAlert), drawn offscreen.
        sheetCaptures(log: log)

        // After every golden was snapshotted: the QA harness's own peak (takeSnapshot is QA-only), not a budget row.
        log.memory.append(MemoryProbe.report(label: "capture: after all canvas snapshots (QA only; app + WebKit helpers started since launch)", since: baseline))

        // 4. S-WEB checks.
        await webChecks(canvas, decisions: { decisions }, log: log)
        log.info["servedPaths"] = canvas.servedPaths.joined(separator: ", ")
        return log.finish()
    }

    /// The whole-window captures: these goldens on these pages (nil: the page the window lands on), light and dark.
    /// A fixed Settings state for the offscreen renders, so the Settings page is drawn with its controls: a full install
    /// with Codex missing and the person's own status line. Never read from this Mac (no installer runs in a capture).
    static let sampleSettings = SettingsState(
        status: InstallStatus(installed: true, version: "0.1.0", parts: [
            .init(id: .app, state: .on), .init(id: .claudePlugin, state: .on), .init(id: .statusline, state: .own),
            .init(id: .codexPlugin, state: .unavailable, why: .agentMissing), .init(id: .scan, state: .on),
        ], updateAvailable: false, updateWhy: .noRelease, answered: true),
        desktopPanel: false, launchAtLogin: .off, canClearHistory: true)

    /// The confirmation sheets drawn as `sheet--<name>--light.png`: the one with a checkbox, a destructive one without,
    /// and one that is not destructive.
    static let sheetCases: [(name: String, action: GuardedAction)] = [
        ("uninstall-all", .uninstallAll), ("clear-history", .clearHistory), ("add-claude-plugin", .addIntegration(.claudePlugin)),
    ]

    /// The real NSAlert of each sheet case (`WindowAlertPresenter.alert(for:)`), laid out and drawn with cacheDisplay. Its
    /// window is never ordered in. Checked on the alert drawn: a destructive one has its button marked so and Return on
    /// Cancel; the uninstall checkbox is there and off. Light only: offscreen, the alert's behind-window material has
    /// nothing to sample and draws light while a dark alert's text draws light too, so a dark PNG would show blank text
    /// that the real sheet never has (macOS draws the sheet itself in dark mode).
    static func sheetCaptures(log: CaptureLog) {
        for c in sheetCases {
            for a in appearances where !a.dark {
                autoreleasepool {
                    let confirmation = c.action.confirmation
                    let (alert, box) = WindowAlertPresenter.alert(for: confirmation)
                    alert.window.appearance = NSAppearance(named: a.dark ? .darkAqua : .aqua)
                    alert.layout()
                    let buttons = alert.buttons
                    let shape = buttons.count == 2 && buttons[0].title == confirmation.button && buttons[1].title == "Cancel"
                        && buttons[0].hasDestructiveAction == confirmation.destructive
                        && (!confirmation.destructive || buttons[1].keyEquivalent == "\r")
                        && (box == nil) == (confirmation.option == nil) && box?.state != .on
                    log.check(shape && !alert.window.isVisible, "sheet \(c.name) \(a.name): buttons, checkbox and Cancel default as designed, never shown")
                    guard let view = alert.window.contentView else { log.fail("sheet \(c.name) \(a.name): no content view"); return }
                    view.layoutSubtreeIfNeeded()
                    log.write(Offscreen.encode(Offscreen.bitmap(of: view)), "sheet--\(c.name)--\(a.name).png")
                }
            }
        }
    }

    static let windowCases: [(slug: String, page: ControlCenterPage?)] = [
        ("snapshot-you-and-codex", nil), ("snapshot-you-and-codex", .timeline), ("snapshot-you-and-codex", .settings),
        ("snapshot-agent-by_elimination", nil), ("snapshot-empty", nil), ("app-not-set-up", nil),
    ]

    /// The real Control Center window (`ControlCenterWindow.make`: title bar, unified toolbar, native sidebar, the canvas
    /// column), built for each case and drawn into a bitmap. It is NEVER ordered in: no window, Dock icon or menu bar item
    /// appears (the app's activation policy is `.prohibited` here). The frame view draws the title bar, window buttons,
    /// toolbar and sidebar with cacheDisplay; the page is the web view's own snapshot, drawn where the web view sits.
    /// Behind-window materials (the sidebar's vibrancy) have no desktop behind them offscreen, so they come out flat.
    static func windowCaptures(_ canvas: CanvasWebView, inputs: [(slug: String, display: GlanceDisplay, snapshot: Snapshot?, now: Date)],
                               log: CaptureLog) async {
        let target = CaptureToolbarTarget()
        for c in windowCases {
            guard let input = inputs.first(where: { $0.slug == c.slug }) else {
                log.fail("window: no golden \(c.slug) to draw the window with"); continue
            }
            for a in appearances {
                let model = ControlCenterModel(display: input.display, snapshot: input.snapshot, page: c.page)
                let content = ControlCenterContentView(size: theme.metrics.controlCenter)
                let toolbar = ControlCenterToolbar(target: target)
                let (w, _) = ControlCenterWindow.make(model: model, content: content, toolbar: toolbar, reduceMotion: true, forCapture: true)
                w.appearance = NSAppearance(named: a.dark ? .darkAqua : .aqua)
                content.setCanvas(canvas.webView)
                w.layoutIfNeeded()
                w.contentView?.superview?.layoutSubtreeIfNeeded()
                w.toolbar?.validateVisibleItems()
                let view = BridgePolicy.viewArgument(display: input.display, page: model.page, agentID: model.agentID, dark: a.dark,
                                                     now: input.now, timeZone: .current, launchAtLogin: .off, settings: sampleSettings)
                let result = try? await canvas.render(snapshot: input.snapshot, view: view)
                log.check(result as? String == "rendered", "\(c.slug) \(model.page.rawValue) \(a.name): window canvas render")
                // The window's own structure, checked on the very window drawn: nothing under the title bar or toolbar, the
                // web view inside the content layout rect, and the window never shown.
                let web = canvas.webView
                let inContent = w.contentView.map { cv in
                    let r = cv.convert(web.bounds, from: web)
                    return cv.bounds.insetBy(dx: -0.5, dy: -0.5).contains(r) && abs(w.contentLayoutRect.height - cv.bounds.height) < 0.5
                } ?? false
                log.check(inContent && !w.styleMask.contains(.fullSizeContentView) && !w.isVisible,
                          "\(c.slug) \(model.page.rawValue) \(a.name): window: the page sits below the toolbar, the window was never shown")
                let snapshot = try? await web.takeSnapshot(configuration: nil)
                let name = "\(c.slug)--window--\(model.page.rawValue)--\(a.name).png"
                log.write(Offscreen.window(w, web: snapshot, webView: web), name)
                content.setCanvas(CanvasPlaceholderView(message: ""))   // hand the web view back
                w.contentViewController = nil
            }
        }
    }

    /// The first snapshot golden the Control Center would show as it is (display ok), for the memory steady state.
    static func firstShownSnapshot(_ manifest: Manifest, fixtures: URL) -> (slug: String, display: GlanceDisplay, snapshot: Snapshot, now: Date)? {
        for entry in manifest.fixtures where entry.contract == "snapshot" && entry.expect.display == "ok" {
            guard let data = try? Data(contentsOf: fixtures.appendingPathComponent(entry.file)), let now = ContractDate.parse(entry.now) else { continue }
            let (status, snapshot) = ContractFile.readSnapshot(data)
            guard status == .ok, let snapshot else { continue }
            let slug = entry.file.replacingOccurrences(of: ".json", with: "").replacingOccurrences(of: "/", with: "-")
            return (slug, GlanceDisplay.make(status: status, glance: snapshot.glancePart, now: now), snapshot, now)
        }
        return nil
    }

    static func webChecks(_ canvas: CanvasWebView, decisions: () -> [BridgeDecision], log: CaptureLog) async {
        let probe = "https://example.invalid/wasitme-capture-probe"
        log.check(await canvas.evaluate("return document.documentElement.dataset.wasitmeReady === '1';") as? Bool == true,
                  "S-WEB: app.js set its DOM marker (script-src wasitme-app: works)")
        let canary = await canvas.evaluate("return document.documentElement.dataset.inlineCanary === 'present';") as? Bool == true
        log.info["inlineCanaryPresent"] = canary ? "yes" : "no (not the placeholder page)"
        log.check(await canvas.evaluate("return document.documentElement.dataset.inlineRan !== '1';") as? Bool == true,
                  "S-WEB: the inline script canary was blocked by the CSP header")
        log.check(await canvas.evaluate("try { await fetch(url); return 'loaded'; } catch (e) { return 'blocked'; }",
                                        arguments: ["url": probe]) as? String == "blocked",
                  "S-WEB: a remote fetch is blocked")
        log.check(await canvas.evaluate(
            "return await new Promise(function (resolve) { var i = new Image(); i.onload = function () { resolve('loaded'); }; i.onerror = function () { resolve('blocked'); }; i.src = url; });",
            arguments: ["url": probe]) as? String == "blocked", "S-WEB: a remote image is blocked")

        let before = canvas.rejectedMessages
        _ = await canvas.evaluate("window.webkit.messageHandlers.wasitme.postMessage({ action: 'rm -rf /' }); return true;")
        _ = await canvas.evaluate("window.webkit.messageHandlers.wasitme.postMessage({ action: 'uninstallAll' }); window.webkit.messageHandlers.wasitme.postMessage({ action: 'removeIntegration', integration: 'statusline' }); return true;")
        try? await Task.sleep(for: .milliseconds(300))
        log.check(canvas.rejectedMessages > before, "bridge: an unknown action is rejected")
        log.check(decisions().contains(.confirm(.uninstallAll)) && decisions().contains(.confirm(.removeIntegration(.statusline))),
                  "bridge: a change to the user's setup only reaches the native side as a request (the app shows a native sheet; capture shows nothing)")
        _ = await canvas.evaluate("window.webkit.messageHandlers.wasitme.postMessage({ action: 'copyReport' }); window.webkit.messageHandlers.wasitme.postMessage({ action: 'openMarkdown' }); return true;")
        try? await Task.sleep(for: .milliseconds(300))
        log.check(decisions().contains(.perform(.copyReport)) && decisions().contains(.perform(.openMarkdown)),
                  "bridge: copyReport and openMarkdown arrive as named actions (capture performs neither)")
        log.check(await canvas.evaluate("return document.querySelector('.window--content') !== null && document.querySelector('aside.sidebar') === null;") as? Bool == true,
                  "canvas: view.chrome \"content\" draws only the page (the window's sidebar is native)")

        let deniedBefore = canvas.deniedNavigations
        _ = await canvas.evaluate("window.location.href = url; return true;", arguments: ["url": probe])
        try? await Task.sleep(for: .milliseconds(500))
        let href = await canvas.evaluate("return location.href;") as? String
        log.check(href == CanvasRouter.entryURL.absoluteString && canvas.deniedNavigations > deniedBefore,
                  "S-WEB: navigation away from the canvas is denied")
    }

    /// Walks up from the executable and the working directory looking for contract/fixtures/manifest.json.
    static func findFixtures() -> URL? {
        var starts: [URL] = [URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)]
        if let exe = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent() { starts.append(exe) }
        for start in starts {
            var dir = start.standardizedFileURL
            for _ in 0..<10 {
                let candidate = dir.appendingPathComponent("contract/fixtures", isDirectory: true)
                if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("manifest.json").path) { return candidate }
                let parent = dir.deletingLastPathComponent()
                if parent.path == dir.path { break }
                dir = parent
            }
        }
        return nil
    }
}

/// The toolbar's target in a capture: answers the Control Center's toolbar actions (so the items draw enabled, as they are
/// in the app with a report to show) and does nothing with them.
@MainActor
final class CaptureToolbarTarget: NSObject {
    @objc func checkAgain(_ sender: Any?) {}
    @objc func copyReport(_ sender: Any?) {}
    @objc func openMarkdown(_ sender: Any?) {}
}

/// Collects files, checks and notes; writes `index.json`.
@MainActor
final class CaptureLog {
    let out: URL
    var files: [String] = []
    var passed: [String] = []
    var failures: [String] = []
    var info: [String: String] = [:]
    var memory: [MemoryProbe.Report] = []
    var budgets: [MemoryBudget.Check] = []

    init(out: URL) { self.out = out }

    /// The budgets are about the shipping (release) build: a debug build only reports them, a release build fails on
    /// one that is over.
    static let budgetsEnforced: Bool = {
        #if DEBUG
        false
        #else
        true
        #endif
    }()

    func budget(_ c: MemoryBudget.Check) {
        budgets.append(c)
        if Self.budgetsEnforced { check(c.within, "memory budget: \(c.line)") }
    }

    func write(_ png: Data?, _ name: String) {
        guard let png else { fail("\(name): render produced no image"); return }
        do { try png.write(to: out.appendingPathComponent(name), options: .atomic); files.append(name) } catch { fail("\(name): \(error)") }
    }

    func check(_ ok: Bool, _ what: String) { ok ? passed.append(what) : failures.append(what) }
    func fail(_ what: String) { failures.append(what) }

    func finish() -> Int32 {
        struct Index: Encodable {
            let files: [String]; let passed: [String]; let failures: [String]; let info: [String: String]; let memory: [MemoryProbe.Report]
            let budgets: [MemoryBudget.Check]; let budgetsEnforced: Bool
        }
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? e.encode(Index(files: files, passed: passed, failures: failures, info: info, memory: memory,
                                          budgets: budgets, budgetsEnforced: Self.budgetsEnforced)) {
            try? data.write(to: out.appendingPathComponent("index.json"), options: .atomic)
        }
        print("capture: \(files.count) PNGs, \(passed.count) checks passed, \(failures.count) failed -> \(out.path)")
        memory.forEach { print("memory: \($0.label): \($0.summary)") }
        let mode = Self.budgetsEnforced ? "release build, enforced" : "debug build, reported only"
        budgets.forEach { print("memory budget (\(mode)): \($0.line)") }
        failures.forEach { print("FAILED: \($0)") }
        fflush(stdout)
        return failures.isEmpty ? 0 : 1
    }
}

/// Offscreen drawing helpers.
@MainActor
enum Offscreen {
    /// Each render drains its own autorelease pool: the whole capture runs inside one run-loop turn.
    static func png<V: View>(_ view: V, size: CGSize, dark: Bool) -> Data? {
        autoreleasepool {
            let host = NSHostingView(rootView: view.environment(\.colorScheme, dark ? .dark : .light))
            host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            return encode(bitmap(of: host))
        }
    }

    static func bitmap(of view: NSView) -> NSBitmapImageRep? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        rep.size = view.bounds.size
        return rep
    }

    static func encode(_ rep: NSBitmapImageRep?) -> Data? { rep?.representation(using: .png, properties: [:]) }

    /// The content view drawn with cacheDisplay (the web view's area comes out empty), with the web view's
    /// own snapshot drawn into that area.
    static func composite(_ content: NSView, web: NSImage?, webFrame: NSRect) -> Data? {
        autoreleasepool { compositeInPool(content, web: web, webFrame: webFrame) }
    }

    /// A whole window that was never ordered in: its frame view (title bar, window buttons, toolbar, the content view and
    /// everything in it) drawn with cacheDisplay, with the web view's own snapshot drawn where the web view sits.
    static func window(_ window: NSWindow, web: NSImage?, webView: NSView) -> Data? {
        autoreleasepool {
            guard let frameView = window.contentView?.superview else { return nil }
            frameView.layoutSubtreeIfNeeded()
            guard let rep = bitmap(of: frameView) else { return nil }
            if let web, let ctx = NSGraphicsContext(bitmapImageRep: rep) {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = ctx
                let r = frameView.convert(webView.bounds, from: webView)
                // The bitmap context is not flipped; the frame view may be.
                let y = frameView.isFlipped ? frameView.bounds.height - r.maxY : r.minY - frameView.bounds.minY
                web.draw(in: NSRect(x: r.minX - frameView.bounds.minX, y: y, width: r.width, height: r.height))
                NSGraphicsContext.restoreGraphicsState()
            }
            return encode(rep)
        }
    }

    private static func compositeInPool(_ content: NSView, web: NSImage?, webFrame: NSRect) -> Data? {
        guard let rep = bitmap(of: content) else { return nil }
        if let web, let ctx = NSGraphicsContext(bitmapImageRep: rep) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = ctx
            // content is flipped (y down); the bitmap context is not.
            let r = NSRect(x: webFrame.minX, y: content.bounds.height - webFrame.maxY, width: webFrame.width, height: webFrame.height)
            web.draw(in: r)
            NSGraphicsContext.restoreGraphicsState()
        }
        return encode(rep)
    }
}

/// A strip that stands in for the menu bar: the template glyph as the system would tint it, dimmed when
/// the display says so, and the exact VoiceOver label / tooltip next to it (so the PNG documents both).
struct MenuBarPreview: View {
    static let size = CGSize(width: 480, height: 30)
    let display: GlanceDisplay

    var body: some View {
        HStack(spacing: theme.spacing.s2) {
            HStack(spacing: 3) {
                Image(nsImage: theme.glyphs.menuBarImage(display.glyph, pointSize: theme.metrics.menuBarGlyphLarge))
                    .renderingMode(.template)
                    .foregroundStyle((display.glyphDimmed ? theme.palette.inkMuted : theme.palette.ink).color)
                if display.newEventCount > 0 {
                    plain(Tokens.FindingState.newChangesText(display.newEventCount)).typeStyle(theme.type.typedSm).ink(theme.palette.ink)
                }
            }
            .padding(.horizontal, 6)
            .frame(height: 22)
            .background(theme.palette.well.color, in: RoundedRectangle(cornerRadius: theme.radii.control, style: .continuous))
            plain(display.accessibilityLabel).typeStyle(theme.type.typedSm).ink(theme.palette.inkSecondary)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, theme.spacing.s2)
        .frame(width: Self.size.width, height: Self.size.height)
        .background(theme.palette.raised.color)
    }
}

/// Every glyph at true 16 and 18 pt as a template (plain and dimmed), at the desktop panel's 30 pt, and as its chip,
/// with its name and legend line: the six finding states, the six app states (tokens.json appStates), then the mark.
/// The sheet a blind-naming test of the glyphs (D57) can be run against.
struct GlyphSheet: View {
    static let size = CGSize(width: 760, height: 660)

    var body: some View {
        VStack(alignment: .leading, spacing: theme.spacing.s2) {
            plain("Menu bar glyphs").typeStyle(theme.type.title).ink(theme.palette.ink)
            plain("design/system/glyphs: the six finding states and the six app states; template images, tinted by the system")
                .typeStyle(theme.type.note).ink(theme.palette.inkSecondary)
            ForEach(Array(MenuBarGlyph.allCases.enumerated()), id: \.offset) { item in
                let g = item.element
                HStack(spacing: theme.spacing.s4) {
                    plain(String(describing: g)).typeStyle(theme.type.typedSm).ink(theme.palette.inkSecondary).frame(width: 130, alignment: .leading)
                    template(g, .g16, 16, dimmed: false)
                    template(g, .g18, 18, dimmed: false)
                    template(g, .g18, 18, dimmed: true)
                    GlyphView(glyph: g, grid: .g18, size: theme.metrics.panelGlyph).frame(width: 34, height: 32)
                    StateChip(glyph: g, text: g.findingState?.label ?? g.appState?.label ?? "")
                    Spacer(minLength: 0)
                    plain(g.findingState?.legend ?? g.appState?.legend ?? "").typeStyle(theme.type.note).ink(theme.palette.inkMuted).lineLimit(1)
                }
                .frame(height: 34)
            }
            HStack(spacing: theme.spacing.s4) {
                plain("mark").typeStyle(theme.type.typedSm).ink(theme.palette.inkSecondary).frame(width: 130, alignment: .leading)
                ForEach([GlyphGrid.g16, .g18], id: \.self) { grid in
                    Image(nsImage: theme.glyphs.markImage(grid: grid, pointSize: CGFloat(grid.rawValue)))
                        .renderingMode(.template).foregroundStyle(theme.palette.ink.color).frame(width: 22, height: 22)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(theme.spacing.s6)
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(theme.palette.sheet.color)
    }

    private func template(_ g: MenuBarGlyph, _ grid: GlyphGrid, _ pt: CGFloat, dimmed: Bool) -> some View {
        Image(nsImage: theme.glyphs.templateImage(g, grid: grid, pointSize: pt))
            .renderingMode(.template)
            .foregroundStyle((dimmed ? theme.palette.inkMuted : theme.palette.ink).color)
            .frame(width: 22, height: 22)
    }
}
