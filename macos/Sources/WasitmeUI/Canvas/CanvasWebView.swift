import AppKit
import WasitmeCore
import WebKit

/// Serves the canvas through `CanvasRouter` (no network, no file URLs).
final class CanvasSchemeHandler: NSObject, WKURLSchemeHandler {
    let assets: CanvasAssetSource
    /// The most recent requests, for capture's log: bounded, so a page that is reloaded many times (a web content
    /// process the system keeps reclaiming) cannot grow this for the life of the app.
    private(set) var servedPaths: [String] = []
    static let maxServedPaths = 256

    init(assets: CanvasAssetSource) { self.assets = assets }

    func note(_ line: String) {
        servedPaths.append(line)
        if servedPaths.count > Self.maxServedPaths { servedPaths.removeFirst(servedPaths.count - Self.maxServedPaths) }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL)); return
        }
        let r = CanvasRouter.respond(to: url, method: urlSchemeTask.request.httpMethod, assets: assets)
        note("\(r.status) \(url.path(percentEncoded: false))")
        guard let response = HTTPURLResponse(url: url, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers) else {
            urlSchemeTask.didFailWithError(URLError(.cannotParseResponse)); return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(r.body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}

/// Receives `postMessage` from the page and hands a checked decision to the owner.
final class CanvasMessageHandler: NSObject, WKScriptMessageHandler {
    var onDecision: (BridgeDecision) -> Void = { _ in }
    private(set) var rejected = 0

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let decision = BridgePolicy.decide(body: message.body, originProtocol: origin.protocol, originHost: origin.host,
                                           isMainFrame: message.frameInfo.isMainFrame)
        if case .reject = decision { rejected += 1 }
        onDecision(decision)
    }
}

/// Denies every navigation but our own scheme, every new window, and every JavaScript dialog (the app
/// never shows a surprise dialog; a page alert is silently dismissed).
final class CanvasLockdown: NSObject, WKNavigationDelegate, WKUIDelegate {
    var onFinish: () -> Void = {}
    var onFail: (String) -> Void = { _ in }
    var onWebContentTerminated: () -> Void = {}
    private(set) var deniedNavigations = 0

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let ok = navigationAction.targetFrame != nil && CanvasNavigationPolicy.allows(navigationAction.request.url)
        if !ok { deniedNavigations += 1 }
        decisionHandler(ok ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onFinish() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        onFail("navigation failed")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        onFail("load failed")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onWebContentTerminated() }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        deniedNavigations += 1
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        completionHandler(false)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        completionHandler(nil)
    }
}

/// How often the canvas is loaded again after its web content process stops, before the app gives up and says so.
///
/// Clock-free (AGENTS.md: never trust the wall clock): it counts stops in a row with no `ready` between them. A page that
/// came up and is stopped later (the system reclaiming a hidden window's process) starts a fresh count, because that is a
/// working canvas, not a broken one. A page that stops before it can post `ready` is retried `limit` times and then
/// reported, so a content process that dies on every load (memory pressure, a broken `--canvas` directory) cannot
/// respawn WebContent processes forever behind a blank window.
struct CanvasReloadPolicy: Equatable, Sendable {
    static let maxConsecutiveReloads = 3
    var limit = Self.maxConsecutiveReloads
    private(set) var consecutiveStops = 0

    /// Records a stop; true when the page should be loaded once more.
    mutating func shouldReload() -> Bool {
        consecutiveStops += 1
        return consecutiveStops <= limit
    }

    mutating func pageBecameReady() { consecutiveStops = 0 }
}

/// The Control Center canvas: a WKWebView locked down per D48.
///  - pages come only from `wasitme-app://canvas/` (CanvasSchemeHandler), with the strict CSP header;
///  - non-persistent website data store; Safe Browsing lookups off; no inspector;
///  - a content rule list blocks every http(s)/ws(s)/ftp/file load (compiled into a temporary store, so
///    nothing is written under ~/Library);
///  - every other navigation, new window and JS dialog is denied;
///  - data in only via `BridgePolicy.renderBody`; data out only via checked named actions.
@MainActor
public final class CanvasWebView {
    public let webView: WKWebView
    public let assets: CanvasAssetSource
    let schemeHandler: CanvasSchemeHandler
    let messageHandler: CanvasMessageHandler
    let lockdown: CanvasLockdown
    public private(set) var isReady = false
    /// Set when the page could not be brought up: a load that failed before `ready`, or a web content process that
    /// stopped more times in a row than `CanvasReloadPolicy` allows. Never set by a failure on a page that is up (a denied
    /// navigation reports as one, and the page is still there).
    public private(set) var loadError: String?
    /// Called once per `loadError`, so the owner can put a message where the canvas was.
    public var onLoadError: (String) -> Void = { _ in }
    private(set) var loadCount = 0
    private var reloads = CanvasReloadPolicy()
    private var decisionHandler: (BridgeDecision) -> Void = { _ in }
    private var readyWaiters: [CheckedContinuation<Bool, Never>] = []

    /// Blocks every remote or file load the page might attempt (belt and braces with the CSP). One rule per
    /// scheme: WebKit's content-blocker regex supports no disjunctions.
    static let ruleListJSON: String = {
        let rule = #"{"trigger":{"url-filter":"^%@:","url-filter-is-case-sensitive":false},"action":{"type":"block"}}"#
        return "[" + ["https?", "wss?", "ftp", "file"].map { rule.replacingOccurrences(of: "%@", with: $0) }.joined(separator: ",") + "]"
    }()

    /// Compiled once per process.
    private static var compiledRules: WKContentRuleList?

    static func ruleList() async throws -> WKContentRuleList {
        if let compiledRules { return compiledRules }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("wasitme-content-rules", isDirectory: true)     // reused across launches, per user
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let store = WKContentRuleListStore(url: dir) else { throw CanvasError.ruleStore }
        guard let list = try await store.compileContentRuleList(forIdentifier: "wasitme-block-remote",
                                                                encodedContentRuleList: ruleListJSON) else { throw CanvasError.ruleStore }
        compiledRules = list
        return list
    }

    enum CanvasError: Error { case ruleStore }

    /// Fails closed: if the blocking rules can't be compiled, there is no canvas (the window says so).
    public static func make(assets: CanvasAssetSource, size: CGSize) async -> CanvasWebView? {
        guard let rules = try? await ruleList() else { return nil }
        return CanvasWebView(assets: assets, rules: rules, size: size)
    }

    private init(assets: CanvasAssetSource, rules: WKContentRuleList, size: CGSize) {
        self.assets = assets
        schemeHandler = CanvasSchemeHandler(assets: assets)
        messageHandler = CanvasMessageHandler()
        lockdown = CanvasLockdown()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: CanvasRouter.scheme)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = false     // no Safe Browsing network lookups
        config.preferences.isElementFullscreenEnabled = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true    // app.js only (CSP: no inline)
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.suppressesIncrementalRendering = true
        config.userContentController.add(rules)
        config.userContentController.add(messageHandler, contentWorld: .page, name: BridgePolicy.handlerName)

        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        webView.navigationDelegate = lockdown
        webView.uiDelegate = lockdown
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        webView.isInspectable = false
        webView.setAccessibilityLabel("Control Center canvas")

        messageHandler.onDecision = { [weak self] decision in self?.receive(decision) }
        lockdown.onFail = { [weak self] why in self?.loadFailed(why) }
        lockdown.onWebContentTerminated = { [weak self] in self?.webContentStopped() }
    }

    /// Routes page actions to the owner. `.ready` is always handled here first, whether or not an owner is listening.
    public func onDecision(_ handler: @escaping (BridgeDecision) -> Void) {
        decisionHandler = handler
    }

    private func receive(_ decision: BridgeDecision) {
        if decision == .perform(.ready) {
            isReady = true
            reloads.pageBecameReady()
            resolveReady(true)
        }
        decisionHandler(decision)
    }

    /// A load that failed before the page came up. On a page that is up this is the deny path (a navigation the
    /// lockdown cancelled reports as a failed navigation) and the page is still there, so it is not an error.
    private func loadFailed(_ why: String) {
        // Once per failure: a page that keeps stopping past the cap is already reported (`load()` clears it).
        guard !isReady, loadError == nil else { return }
        loadError = why
        resolveReady(false)
        onLoadError(why)
    }

    /// The web content process stopped (crashed, or reclaimed by the system): load the page again, a bounded number
    /// of times in a row; then report it instead of leaving a blank view that respawns processes forever.
    private func webContentStopped() {
        isReady = false
        if reloads.shouldReload() { load() } else { loadFailed("the canvas stopped repeatedly") }
    }

    public func load() {
        loadError = nil
        loadCount += 1
        webView.load(URLRequest(url: CanvasRouter.entryURL)) // wasitme:allow-local-scheme -- entryURL is the app's own wasitme-app:// page
    }

    /// Waits until the page posted `ready` (true) or failed / timed out (false).
    public func waitUntilReady(timeout: TimeInterval = 10) async -> Bool {
        if isReady { return true }
        if loadError != nil { return false }
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            readyWaiters.append(c)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.resolveReady(self?.isReady ?? false)
            }
        }
    }

    private func resolveReady(_ value: Bool) {
        let waiters = readyWaiters
        readyWaiters = []
        for w in waiters { w.resume(returning: value) }
    }

    /// Sends the data to the page: the snapshot and the view as one JSON string each (D48), parsed by the page.
    /// The script is the constant `BridgePolicy.renderBody`.
    @discardableResult
    public func render(snapshot: Snapshot?, view: String) async throws -> Any? {
        // wasitme:allow-string-js -- BridgePolicy.renderBody is a StaticString literal (CanvasBridge.swift); data goes in arguments
        try await webView.callAsyncJavaScript(BridgePolicy.renderBody.description,
                                              arguments: ["snap": BridgePolicy.snapshotArgument(snapshot), "view": view],
                                              contentWorld: .page)
    }

    /// For checks only (capture): a constant script body with data in `arguments`.
    func evaluate(_ constantBody: String, arguments: [String: Any] = [:]) async -> Any? {
        // wasitme:allow-string-js -- capture-only; every caller (CaptureRunner) passes a literal body, data in arguments
        try? await webView.callAsyncJavaScript(constantBody, arguments: arguments, contentWorld: .page)
    }

    public var deniedNavigations: Int { lockdown.deniedNavigations }
    public var rejectedMessages: Int { messageHandler.rejected }
    public var servedPaths: [String] { schemeHandler.servedPaths }
}
