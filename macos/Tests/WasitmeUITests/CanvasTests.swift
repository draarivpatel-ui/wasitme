import Foundation
import Testing
@testable import WasitmeCore
@testable import WasitmeUI

@Suite struct CanvasRouterTests {
    func url(_ s: String) -> URL { URL(string: s)! }

    @Test func servesThePlaceholderWithTheStrictCSP() throws {
        for name in ["app.html", "app.js", "app.css"] {
            let r = CanvasRouter.respond(to: url("wasitme-app://canvas/\(name)"), method: "GET", assets: .embeddedPlaceholder)
            #expect(r.status == 200 && !r.body.isEmpty, "\(name)")
            #expect(r.headers["Content-Security-Policy"] == CanvasRouter.contentSecurityPolicy)
            #expect(r.headers["X-Content-Type-Options"] == "nosniff")
            #expect(r.headers["Content-Length"] == String(r.body.count))
        }
        #expect(CanvasRouter.respond(to: url("wasitme-app://canvas/app.js"), method: nil, assets: .embeddedPlaceholder)
            .headers["Content-Type"] == "text/javascript; charset=utf-8")
    }

    /// The canvas CSP (D48), exactly, plus the two directives that don't fall back to default-src.
    @Test func cspIsStrict() {
        let csp = CanvasRouter.contentSecurityPolicy
        #expect(csp.hasPrefix("default-src 'none'; script-src wasitme-app:; style-src wasitme-app:; font-src wasitme-app:; img-src wasitme-app: data:"))
        #expect(csp.contains("base-uri 'none'") && csp.contains("form-action 'none'"))
        #expect(!csp.contains("unsafe") && !csp.contains("http") && !csp.contains("*"))
    }

    @Test(arguments: [
        "wasitme-app://canvas/../app.html", "wasitme-app://canvas/%2e%2e/app.html", "wasitme-app://canvas/.hidden.js",
        "wasitme-app://canvas/app.exe", "wasitme-app://canvas/", "wasitme-app://canvas/missing.html",
        "wasitme-app://other/app.html", "https://canvas/app.html", "file:///etc/passwd", "wasitme-app://canvas/a%2Fb.js",
        "wasitme-app://user@canvas/app.html", "wasitme-app://canvas:8080/app.html", "wasitme-app://canvas/a/b/c/d/e.js",
    ])
    func rejectsEverythingElse(_ s: String) {
        let r = CanvasRouter.respond(to: url(s), method: "GET", assets: .embeddedPlaceholder)
        #expect(r.status == 404, "\(s)")
        #expect(r.headers["Content-Security-Policy"] == CanvasRouter.contentSecurityPolicy, "even a 404 carries the CSP")
    }

    @Test func onlyGET() {
        #expect(CanvasRouter.respond(to: CanvasRouter.entryURL, method: "POST", assets: .embeddedPlaceholder).status == 404)
    }

    @Test func directorySourceServesNestedFilesButNothingOutsideTheRoot() throws {
        let dir = try TempDir("canvas")
        let root = dir.url.appendingPathComponent("ui", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("fonts"), withIntermediateDirectories: true)
        try Data("<!doctype html>".utf8).write(to: root.appendingPathComponent("app.html"))
        try Data([0x77, 0x4F, 0x46, 0x32]).write(to: root.appendingPathComponent("fonts/x.woff2"))
        try Data("secret".utf8).write(to: dir.url.appendingPathComponent("outside.js"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.js"),
                                                   withDestinationURL: dir.url.appendingPathComponent("outside.js"))
        let assets = CanvasAssetSource.directory(root)
        #expect(CanvasRouter.respond(to: url("wasitme-app://canvas/app.html"), method: "GET", assets: assets).status == 200)
        let font = CanvasRouter.respond(to: url("wasitme-app://canvas/fonts/x.woff2"), method: "GET", assets: assets)
        #expect(font.status == 200 && font.headers["Content-Type"] == "font/woff2")
        #expect(CanvasRouter.respond(to: url("wasitme-app://canvas/escape.js"), method: "GET", assets: assets).status == 404,
                "a symlink out of the root is never followed")
        #expect(CanvasRouter.respond(to: url("wasitme-app://canvas/fonts"), method: "GET", assets: assets).status == 404)
    }

    @Test func assetSourceResolution() throws {
        let dir = try TempDir("bundle")
        #expect(CanvasAssetSource.resolve(override: nil, bundleResources: dir.url) == .embeddedPlaceholder)
        let ui = dir.url.appendingPathComponent("ui", isDirectory: true)
        try FileManager.default.createDirectory(at: ui, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: ui.appendingPathComponent("app.html"))
        #expect(CanvasAssetSource.resolve(override: nil, bundleResources: dir.url) == .directory(ui.standardizedFileURL))
        let other = dir.url.appendingPathComponent("dev", isDirectory: true)
        #expect(CanvasAssetSource.resolve(override: other, bundleResources: dir.url) == .directory(other.standardizedFileURL))
    }

    @Test func navigationPolicyAllowsOnlyTheCanvas() {
        #expect(CanvasNavigationPolicy.allows(CanvasRouter.entryURL))
        for s in ["https://example.invalid/", "file:///Users/", "about:blank", "wasitme-app://other/app.html", "javascript:alert(1)", "data:text/html,x"] {
            #expect(!CanvasNavigationPolicy.allows(URL(string: s)), "\(s)")
        }
        #expect(!CanvasNavigationPolicy.allows(nil))
    }

    /// The placeholder page follows the rules the real canvas must: no inline style, text via textContent,
    /// no string-built code. Its single inline script is the CSP canary (capture checks it stays blocked).
    @Test func placeholderPageFollowsTheCanvasRules() {
        let html = PlaceholderCanvas.html, js = PlaceholderCanvas.js
        #expect(!html.contains("style=") && !html.contains("<style"))
        #expect(html.components(separatedBy: "<script>").count == 2, "only the CSP canary is inline")
        #expect(html.contains(#"<script src="app.js"></script>"#))
        for banned in ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setTimeout(\"", "http"] {
            #expect(!js.contains(banned), "\(banned) in app.js")
        }
        #expect(!PlaceholderCanvas.css.contains("http") && !PlaceholderCanvas.css.contains("@import") && !PlaceholderCanvas.css.contains("url("))
    }
}

@Suite struct BridgePolicyTests {
    func decide(_ body: Any, proto: String = "wasitme-app", host: String = "canvas", main: Bool = true) -> BridgeDecision {
        BridgePolicy.decide(body: body, originProtocol: proto, originHost: host, isMainFrame: main)
    }

    @Test func namedActionsOnly() {
        #expect(decide(["action": "ready"]) == .perform(.ready))
        #expect(decide(["action": "scanNow"]) == .perform(.scanNow))
        #expect(decide(["action": "showPage", "page": "sources"]) == .perform(.showPage(.sources)))
        #expect(decide(["action": "selectAgent", "agent": "codex"]) == .perform(.selectAgent("codex")))
        #expect(decide(["action": "copyReport"]) == .perform(.copyReport))
        #expect(decide(["action": "openMarkdown"]) == .perform(.openMarkdown))
        #expect(decide(["action": "showPage", "page": "verdict"]) == .perform(.showPage(.verdict)))
        #expect(decide(["action": "setLaunchAtLogin", "enabled": true]) == .perform(.setLaunchAtLogin(true)))
        #expect(decide(["action": "setLaunchAtLogin", "enabled": false]) == .perform(.setLaunchAtLogin(false)))
        for bad: Any in [["action": "rm -rf /"], ["action": "showPage", "page": "../../etc"], ["action": "selectAgent", "agent": "a b"],
                         ["action": "scanNow", "extra": 1], ["nope": "x"], "ready", 42, ["action": 7],
                         ["action": "copyReport", "page": "report"], ["action": "openMarkdown", "agent": "codex"],
                         ["action": "showPage", "page": "finding"], ["action": "showPage"], ["action": "showPage", "page": "sources", "agent": "codex"],
                         ["action": "selectAgent", "agent": "codex", "page": "timeline"], ["action": "ready", "enabled": true],
                         ["action": "selectAgent", "agent": String(repeating: "a", count: 33)], [String: Any](),
                         // launch at login takes a JavaScript boolean and nothing else (not 1, not "true", not missing)
                         ["action": "setLaunchAtLogin"], ["action": "setLaunchAtLogin", "enabled": 1], ["action": "setLaunchAtLogin", "enabled": 0],
                         ["action": "setLaunchAtLogin", "enabled": "true"], ["action": "setLaunchAtLogin", "enabled": true, "page": "settings"]] {
            guard case .reject = decide(bad) else { Issue.record("accepted \(bad)"); continue }
        }
    }

    /// Every change to the user's setup only ever becomes a request for a native sheet, with exactly its keys; an unknown
    /// integration id, a missing one, and the pre-Settings names (`deleteHistory`, `uninstall`) are rejected.
    @Test func guardedActionsOnlyAskForConfirmation() {
        // every part can be removed; every part but the app can be added from the app (the installer builds the app)
        #expect(GuardedAction.all.count == IntegrationID.allCases.count * 2 - 1 + 3)
        #expect(!GuardedAction.all.contains(.addIntegration(.app)) && GuardedAction.all.contains(.removeIntegration(.app)))
        for a in GuardedAction.all {
            #expect(decide(a.message) == .confirm(a), "\(a)")
            var extra = a.message
            extra["page"] = "settings"
            guard case .reject = decide(extra) else { Issue.record("\(a) with extra keys"); continue }
        }
        for bad: [String: Any] in [["action": "removeIntegration"], ["action": "addIntegration"],
                                   ["action": "removeIntegration", "integration": "../../bin"],
                                   ["action": "addIntegration", "integration": "mcp"], ["action": "removeIntegration", "integration": 3],
                                   ["action": "clearHistory", "integration": "app"], ["action": "uninstallAll", "enabled": true],
                                   ["action": "deleteHistory"], ["action": "uninstall"]] {
            guard case .reject = decide(bad) else { Issue.record("accepted \(bad)"); continue }
        }
        #expect(IntegrationID.allCases.map(\.installerFlag) == ["--app", "--scan-agent", "--claude-plugin", "--codex-plugin", "--statusline"],
                "the ids are the installer's own flags (scripts/install.sh --help)")
    }

    /// Nothing is wired yet, so every request gets the how-to sheet: it never asks to confirm (no "can't be undone"),
    /// says it isn't available in the app yet, gives the Terminal step and says nothing changed. Only this sheet names
    /// the uninstaller: the canvas's Settings page has buttons, never a Terminal how-to (docs/design/UX-V2.md §9.1).
    /// GuardedActionFlowTests checks no confirmation is ever shown for it.
    @Test func notAvailableSheetsSayHowToDoItInTerminalAndNeverAskToConfirm() throws {
        let pages = try String(contentsOf: Repo.root.appendingPathComponent("ui/src/pages.ts"), encoding: .utf8)
        #expect(!pages.contains("uninstall.sh") && !pages.contains("--purge"), "the canvas's Settings is never a Terminal how-to")
        for a in GuardedAction.all {
            #expect(a.heading.hasSuffix("from Terminal"), "\(a)")
            #expect(a.terminalSteps.hasPrefix("Not available in the app yet. ") && a.terminalSteps.hasSuffix("Nothing was changed."), "\(a)")
            #expect(!a.terminalSteps.contains("can't be undone") && !a.terminalSteps.contains("`"), "\(a)")
            #expect(GuardedPlan.plan(a, available: false) == .inform(heading: a.heading, detail: a.terminalSteps))
            switch a {
            case .removeIntegration, .uninstallAll:
                #expect(a.terminalSteps.contains(GuardedAction.uninstallCommand), "\(a)")
            case .clearHistory:
                // the engine's own command clears the history without uninstalling (engine/src/cli/commands/history.ts)
                #expect(a.terminalSteps.contains(GuardedAction.clearHistoryCommand) && !a.terminalSteps.contains("--purge"))
            case .addIntegration(let id):
                #expect(a.terminalSteps.contains(id.installerFlag) && a.heading.contains(id.title), "\(a)")
            case .updateApp, .updateAcceptingPluginChanges:
                #expect(a.terminalSteps.contains(WasitmeIdentity.updateCommand))
            }
        }
        #expect(GuardedAction.clearHistoryCommand == "wasitme history clear")
    }

    /// When a change can run, the plan is a native confirmation: its own question and button, destructive ones drawn so.
    @Test func availableChangesAreConfirmedNatively() {
        for a in GuardedAction.all {
            let c = a.confirmation
            #expect(GuardedPlan.plan(a, available: true) == .confirm(c))
            #expect(c.question.hasSuffix("?") && !c.button.isEmpty && c.button != "OK" && c.destructive == a.isDestructive, "\(a)")
        }
        #expect(GuardedAction.removeIntegration(.claudePlugin).isDestructive && GuardedAction.uninstallAll.isDestructive)
        #expect(!GuardedAction.addIntegration(.statusline).isDestructive && !GuardedAction.updateApp.isDestructive)
    }

    @Test func foreignOriginsAndSubframesAreRejected() {
        for (p, h, m) in [("https", "canvas", true), ("wasitme-app", "evil", true), ("wasitme-app", "canvas", false), ("file", "", true)] {
            guard case .reject = decide(["action": "scanNow"], proto: p, host: h, main: m) else { Issue.record("\(p)://\(h) main=\(m)"); continue }
        }
    }

    /// Data travels in `arguments` only; the script is one constant (CI bans string-built JS: scripts/check-repo.mjs).
    @Test func theRenderScriptIsAConstant() {
        #expect(BridgePolicy.renderBody.description == "return window.wasitme.render(snap, view);")
    }

    /// Every JavaScript call site in the app passes a constant body: no interpolation, no concatenation,
    /// and no `evaluateJavaScript` at all.
    @Test func noStringBuiltJavaScriptInTheSources() throws {
        for file in Repo.swiftFiles(under: Repo.allSources) {
            let text = try String(contentsOf: file, encoding: .utf8)
            #expect(!text.contains("evaluateJavaScript("), "\(file.lastPathComponent): use callAsyncJavaScript with arguments")
            for line in text.split(separator: "\n") where line.contains("callAsyncJavaScript(") || line.contains("evaluate(\"") {
                #expect(!line.contains("\\(") && !line.contains("\" +") && !line.contains("+ \""), "\(file.lastPathComponent): \(line)")
            }
            for line in text.split(separator: "\n") where line.contains("callAsyncJavaScript(") && !line.contains("///") {
                #expect(line.contains("BridgePolicy.renderBody") || line.contains("constantBody"), "\(file.lastPathComponent): \(line)")
            }
        }
    }

    /// D48: the snapshot travels as ONE JSON string (parsed in the page), sanitized, `null` when there is none.
    @Test func snapshotArgumentIsOneSanitizedJSONString() throws {
        let data = try Data(contentsOf: Repo.fixtures.appendingPathComponent("snapshot/you-and-codex.json"))
        let (_, snap) = ContractFile.readSnapshot(data)
        let text = BridgePolicy.snapshotArgument(try #require(snap))
        let arg = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        #expect((arg["agents"] as? [Any])?.count == 2)
        #expect(BridgePolicy.snapshotArgument(nil) == "null")
        let hostile = BridgePolicy.sanitized(["k\u{1B}[31m": "a\u{202E}b\u{0}c", "n": 3, "list": ["\u{200B}x"]]) as? [String: Any]
        #expect(hostile?["k"] as? String == "abc")
        #expect((hostile?["list"] as? [String])?.first == "x")
        #expect(hostile?["n"] as? Int == 3)
        // a `__proto__` key is just data inside a JSON string; NaN never reaches the page (JSONSerialization would raise)
        #expect(BridgePolicy.json(["__proto__": ["x": 1]]).contains("\"__proto__\""))
        #expect(BridgePolicy.json(["x": Double.nan]) == "null")
    }

    /// The view: page, agent, appearance, the moment and zone to judge freshness and print times in, chrome "content" (the
    /// window's sidebar is native), and the launch-at-login switch's state.
    @Test func viewArgumentCarriesOnlyDisplayWords() throws {
        let entry = try #require(Repo.manifest.first { $0.file == "glance/calibration_pending.json" })
        let d = try #require(Repo.display(entry))
        let now = try #require(ContractDate.parse(entry.now))
        let zone = try #require(TimeZone(identifier: "America/Chicago"))
        let v = BridgePolicy.viewObject(display: d, page: .timeline, agentID: nil, dark: true, now: now, timeZone: zone)
        #expect(v["page"] as? String == "timeline" && v["appearance"] as? String == "dark" && v["agent"] as? String == "claude-code")
        #expect(v["chrome"] as? String == "content")
        #expect(v["launchAtLogin"] as? String == "unavailable", "nothing claimed before the switch was read")
        for s in LaunchAtLoginState.allCases {
            let w = BridgePolicy.viewObject(display: d, page: .settings, agentID: nil, dark: false, now: now, timeZone: zone, launchAtLogin: s)
            #expect(w["launchAtLogin"] as? String == s.rawValue)
        }
        #expect(LaunchAtLoginState.allCases.map(\.rawValue) == ["on", "off", "needsApproval", "viaInstaller", "unavailable"])
        #expect(v["now"] as? String == "2026-10-04T18:30:00.000Z" && v["timeZone"] as? String == "America/Chicago")
        let agents = try #require(v["agents"] as? [[String: Any]])
        #expect(agents.map { $0["stateText"] as? String } == ["Your side", "Timeline only"])
        let text = BridgePolicy.viewArgument(display: d, page: .verdict, agentID: "codex", dark: false, now: now, timeZone: zone)
        let parsed = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        #expect(parsed["page"] as? String == "verdict" && parsed["pageTitle"] as? String == "Finding" && parsed["agent"] as? String == "codex")
        #expect(ControlCenterPage.landing(for: .verdict) == .verdict && ControlCenterPage.landing(for: .timeline) == .timeline)
    }
}

/// The canvas after its web content process stops (crash, or reclaimed by the system), and after a failed load.
/// The stop itself is driven through the lockdown's callback: WebKit has no public way to kill the content process.
@Suite @MainActor struct CanvasReloadTests {
    private let size = CGSize(width: 320, height: 200)

    @Test func policyCapsStopsInARowAndStartsAFreshCountAfterReady() {
        var p = CanvasReloadPolicy()
        for i in 0..<CanvasReloadPolicy.maxConsecutiveReloads {
            let again = p.shouldReload()
            #expect(again, "reload \(i + 1)")
        }
        let over = p.shouldReload(), stillOver = p.shouldReload()
        #expect(!over && !stillOver, "once over the cap it stays over")
        p.pageBecameReady()
        #expect(p.consecutiveStops == 0)
        let fresh = p.shouldReload()
        #expect(fresh && p.consecutiveStops == 1, "a page that came up starts a fresh count")
    }

    @Test func aContentProcessThatKeepsStoppingIsReloadedABoundedNumberOfTimesThenReportedOnce() async throws {
        _ = Headless.ready
        let canvas = try #require(await CanvasWebView.make(assets: .embeddedPlaceholder, size: size))
        var errors: [String] = []
        canvas.onLoadError = { errors.append($0) }
        canvas.load()
        let loads = canvas.loadCount
        for _ in 0..<CanvasReloadPolicy.maxConsecutiveReloads { canvas.lockdown.onWebContentTerminated() }
        #expect(canvas.loadCount == loads + CanvasReloadPolicy.maxConsecutiveReloads, "every stop under the cap reloads")
        #expect(errors.isEmpty && canvas.loadError == nil)
        canvas.lockdown.onWebContentTerminated()
        #expect(canvas.loadCount == loads + CanvasReloadPolicy.maxConsecutiveReloads, "no reload past the cap")
        #expect(errors.count == 1 && canvas.loadError != nil && !canvas.isReady)
        canvas.lockdown.onWebContentTerminated()
        #expect(canvas.loadCount == loads + CanvasReloadPolicy.maxConsecutiveReloads && errors.count == 1, "reported once, not per stop")
    }

    @Test func aPageThatIsUpIsNotReportedBrokenByADeniedNavigationAndResetsTheCount() async throws {
        _ = Headless.ready
        let canvas = try #require(await CanvasWebView.make(assets: .embeddedPlaceholder, size: size))
        var errors: [String] = []
        var seen: [BridgeDecision] = []
        canvas.onLoadError = { errors.append($0) }
        canvas.onDecision { seen.append($0) }
        canvas.messageHandler.onDecision(.perform(.ready))
        #expect(canvas.isReady && seen == [.perform(.ready)], "ready is handled first, then passed on")
        canvas.lockdown.onFail("navigation failed")                  // the deny path on a working page
        #expect(errors.isEmpty && canvas.loadError == nil && canvas.isReady)
        for _ in 0..<CanvasReloadPolicy.maxConsecutiveReloads { canvas.lockdown.onWebContentTerminated() }
        #expect(errors.isEmpty && !canvas.isReady)
        canvas.messageHandler.onDecision(.perform(.ready))            // came up again in between
        for _ in 0..<CanvasReloadPolicy.maxConsecutiveReloads { canvas.lockdown.onWebContentTerminated() }
        #expect(errors.isEmpty, "a page that came up in between starts a fresh count")
        canvas.lockdown.onWebContentTerminated()
        #expect(errors.count == 1)
    }

    @Test func aLoadThatFailsBeforeReadyIsReportedAndReadyIsTrackedWithoutAnOwner() async throws {
        _ = Headless.ready
        let canvas = try #require(await CanvasWebView.make(assets: .embeddedPlaceholder, size: size))
        var errors: [String] = []
        canvas.onLoadError = { errors.append($0) }
        canvas.lockdown.onFail("load failed")
        #expect(errors == ["load failed"] && canvas.loadError == "load failed")
        canvas.messageHandler.onDecision(.perform(.ready))            // no onDecision owner was ever set
        #expect(canvas.isReady)
    }

    @Test func servedPathsAreBounded() {
        let handler = CanvasSchemeHandler(assets: .embeddedPlaceholder)
        for i in 0..<(CanvasSchemeHandler.maxServedPaths + 50) { handler.note("200 /p\(i).js") }
        #expect(handler.servedPaths.count == CanvasSchemeHandler.maxServedPaths)
        #expect(handler.servedPaths.last == "200 /p\(CanvasSchemeHandler.maxServedPaths + 49).js", "the newest entries are kept")
    }
}
