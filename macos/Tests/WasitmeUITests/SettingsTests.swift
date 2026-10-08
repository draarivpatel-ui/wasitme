import Foundation
import os
import Testing
@testable import WasitmeCore
@testable import WasitmeUI

// The Settings page's actions on the native side: what the bridge accepts, where each decision goes, that nothing
// changes the user's setup without a yes in a native sheet, the argv each confirmed change runs, and the state the page
// is sent. No test here starts an installer, opens Finder, shows a panel or quits anything: processes are recorded,
// and quitting, scanning and the panel are recording closures.

private func decide(_ body: Any) -> BridgeDecision {
    BridgePolicy.decide(body: body, originProtocol: "wasitme-app", originHost: "canvas", isMainFrame: true)
}

private func isReject(_ d: BridgeDecision) -> Bool { if case .reject = d { true } else { false } }

/// Polls until `condition` holds or `timeout` passes.
@MainActor private func eventually(timeout: TimeInterval = 5, _ condition: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

@Suite struct SettingsBridgeTests {
    /// UX-V2 §10.1's `id` / `value` and the built `integration` / `enabled`: either spelling, never both, nothing else.
    @Test func bothSpellingsOfEachKeyAreAccepted() {
        for (key, raw, id) in [("integration", "statusline", IntegrationID.statusline), ("id", "codex-plugin", .codexPlugin),
                               ("id", "scan", .scan), ("integration", "scan-agent", .scan)] {
            #expect(decide(["action": "removeIntegration", key: raw]) == .confirm(.removeIntegration(id)), "\(key)=\(raw)")
            #expect(decide(["action": "addIntegration", key: raw]) == .confirm(.addIntegration(id)), "\(key)=\(raw)")
        }
        for key in ["enabled", "value"] {
            #expect(decide(["action": "setLaunchAtLogin", key: true]) == .perform(.setLaunchAtLogin(true)))
            #expect(decide(["action": "setDesktopPanel", key: false]) == .perform(.setDesktopPanel(false)))
            #expect(decide(["action": "setDesktopPanel", key: true]) == .perform(.setDesktopPanel(true)))
        }
        #expect(decide(["action": "revealDataFolder"]) == .perform(.revealDataFolder))
        #expect(decide(["action": "removeIntegration", "integration": "app"]) == .confirm(.removeIntegration(.app)))
    }

    @Test func everythingElseIsRejected() {
        let bad: [[String: Any]] = [
            ["action": "removeIntegration", "integration": "scan", "id": "scan"],          // both spellings
            ["action": "setDesktopPanel", "enabled": true, "value": true],
            ["action": "setDesktopPanel"], ["action": "setDesktopPanel", "value": 1], ["action": "setDesktopPanel", "value": "true"],
            ["action": "setDesktopPanel", "value": NSNull()],
            ["action": "revealDataFolder", "page": "settings"], ["action": "revealDataFolder", "value": true],
            ["action": "addIntegration", "integration": "app"], ["action": "addIntegration", "id": "app"],  // only the installer adds the app
            ["action": "addIntegration", "id": "../../bin"], ["action": "removeIntegration", "id": 1],
            ["action": "removeIntegration", "id": String(repeating: "a", count: 40)],
            ["action": "clearHistory", "id": "app"], ["action": "uninstallAll", "value": true], ["action": "updateApp", "value": true],
            ["action": "updateAcceptingPluginChanges"], ["action": "setDesktopPanel", "enabled": true, "page": "settings"],
            ["action": "deleteHistory"], ["action": "uninstall"], ["action": "uninstallAll", "purge": true],
        ]
        for b in bad { #expect(isReject(decide(b)), "accepted \(b)") }
        // a subframe or another origin never gets as far as a sheet
        #expect(isReject(BridgePolicy.decide(body: ["action": "uninstallAll"], originProtocol: "https", originHost: "canvas", isMainFrame: true)))
        #expect(isReject(BridgePolicy.decide(body: ["action": "uninstallAll"], originProtocol: "wasitme-app", originHost: "canvas", isMainFrame: false)))
    }

    /// Every message a Settings control can post decides to a confirmation, never to a performed change.
    @Test func setupChangesOnlyEverBecomeConfirmations() {
        for a in GuardedAction.all {
            #expect(decide(a.message) == .confirm(a), "\(a)")
        }
        #expect(GuardedAction.all.allSatisfy { $0 != .updateAcceptingPluginChanges }, "only the app asks that one")
    }
}

@Suite @MainActor struct SettingsViewTests {
    private func view(_ settings: SettingsState?) throws -> [String: Any] {
        _ = Headless.ready
        let entry = try #require(Repo.manifest.first { $0.contract == "snapshot" && $0.valid })
        let display = try #require(Repo.display(entry))
        let text = BridgePolicy.viewArgument(display: display, page: .settings, agentID: nil, dark: false, now: Date(),
                                             timeZone: .current, launchAtLogin: .viaInstaller, settings: settings)
        return try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    /// `view.settings` holds codes only (UX-V2 §10.2); without it the view object is what it was (backwards compatible),
    /// and the top-level `launchAtLogin` word stays either way.
    @Test func settingsTravelAsCodes() throws {
        let state = SettingsState(
            status: InstallStatus.parse(Data(#"{"schema":"wasitme.install-status/1","installed":true,"version":"0.1.0","integrations":[{"id":"app","state":"on"},{"id":"codex-plugin","state":"unavailable","why":"agent_missing"},{"id":"statusline","state":"own"}],"update":{"available":false,"why":"no_release"}}"#.utf8)),
            desktopPanel: true, launchAtLogin: .viaInstaller, canClearHistory: true, busy: "claude-plugin")
        let v = try view(state)
        #expect(v["chrome"] as? String == "content" && v["launchAtLogin"] as? String == "viaInstaller")
        let s = try #require(v["settings"] as? [String: Any])
        #expect(s["version"] as? String == "0.1.0" && s["installed"] as? Bool == true && s["answered"] as? Bool == true)
        #expect(s["desktopPanel"] as? Bool == true && s["launchAtLogin"] as? Bool == true && s["canClearHistory"] as? Bool == true)
        #expect(s["busy"] as? String == "claude-plugin")
        let update = try #require(s["update"] as? [String: Any])
        #expect(update["available"] as? Bool == false && update["why"] as? String == "no_release")
        let parts = try #require(s["integrations"] as? [[String: Any]])
        #expect(parts.compactMap { $0["id"] as? String } == ["app", "claude-plugin", "statusline", "codex-plugin", "scan"])
        #expect(parts.compactMap { $0["state"] as? String } == ["on", "unknown", "own", "unavailable", "unknown"])
        #expect(parts[3]["why"] as? String == "agent_missing" && parts[0]["why"] == nil)
        // every string in it is a code from a closed set (or the version): no sentence, no path
        let codes = Set(InstallStatus.State.allCases.map(\.rawValue) + InstallStatus.Why.allCases.map(\.rawValue)
                        + IntegrationID.allCases.map(\.rawValue) + ["0.1.0", "claude-plugin"])
        func strings(_ x: Any) -> [String] {
            switch x {
            case let s as String: [s]
            case let a as [Any]: a.flatMap(strings)
            case let d as [String: Any]: d.values.flatMap(strings)
            default: []
            }
        }
        for word in strings(s) { #expect(codes.contains(word), "\(word)") }
        #expect(try view(nil)["settings"] == nil, "no settings: the same view object as before")
    }

    @Test func launchAtLoginSwitchPosition() {
        func value(_ s: LaunchAtLoginState) -> Bool? {
            SettingsState(status: .unknown, desktopPanel: false, launchAtLogin: s, canClearHistory: false).launchAtLoginValue
        }
        #expect(value(.on) == true && value(.needsApproval) == true && value(.viaInstaller) == true)
        #expect(value(.off) == false && value(.unavailable) == nil)
        #expect(SettingsState.initial.viewObject["launchAtLogin"] is NSNull && SettingsState.initial.viewObject["busy"] is NSNull)
        #expect(SettingsState.busyWord(for: .update) == "updateApp" && SettingsState.busyWord(for: .uninstall) == "uninstallAll")
    }
}

/// Records which route a decision took.
@MainActor private final class RouteLog {
    var calls: [String] = []
    var guarded: [GuardedAction] = []
    var routes: ControlCenterRoutes {
        ControlCenterRoutes(
            render: { self.calls.append("render") }, scanNow: { self.calls.append("scanNow") },
            showPage: { self.calls.append("showPage:\($0.rawValue)") }, selectAgent: { self.calls.append("selectAgent:\($0)") },
            copyReport: { self.calls.append("copyReport") }, openMarkdown: { self.calls.append("openMarkdown") },
            setLaunchAtLogin: { self.calls.append("setLaunchAtLogin:\($0)") }, setDesktopPanel: { self.calls.append("setDesktopPanel:\($0)") },
            revealDataFolder: { self.calls.append("revealDataFolder") },
            guarded: { self.calls.append("guarded"); self.guarded.append($0) })
    }
}

@Suite @MainActor struct ControlCenterRoutingTests {
    @Test func eachDecisionTakesExactlyOneRoute() {
        let cases: [([String: Any], String)] = [
            (["action": "ready"], "render"), (["action": "scanNow"], "scanNow"),
            (["action": "showPage", "page": "settings"], "showPage:settings"), (["action": "selectAgent", "agent": "codex"], "selectAgent:codex"),
            (["action": "copyReport"], "copyReport"), (["action": "openMarkdown"], "openMarkdown"),
            (["action": "setLaunchAtLogin", "value": false], "setLaunchAtLogin:false"),
            (["action": "setDesktopPanel", "enabled": true], "setDesktopPanel:true"),
            (["action": "revealDataFolder"], "revealDataFolder"),
        ]
        for (message, route) in cases {
            let log = RouteLog()
            log.routes.route(decide(message))
            #expect(log.calls == [route] && log.guarded.isEmpty, "\(message)")
        }
        // a setup change only ever reaches the sheet flow, with exactly the action asked for
        let guardedCases: [([String: Any], GuardedAction)] = [
            (["action": "clearHistory"], .clearHistory), (["action": "uninstallAll"], .uninstallAll), (["action": "updateApp"], .updateApp),
            (["action": "removeIntegration", "id": "scan"], .removeIntegration(.scan)),
            (["action": "addIntegration", "integration": "statusline"], .addIntegration(.statusline)),
        ]
        for (message, action) in guardedCases {
            let log = RouteLog()
            log.routes.route(decide(message))
            #expect(log.calls == ["guarded"] && log.guarded == [action], "\(message)")
        }
        let log = RouteLog()
        for bad: [String: Any] in [["action": "uninstall"], ["action": "addIntegration", "id": "app"], ["action": "rm -rf"]] {
            log.routes.route(decide(bad))
        }
        #expect(log.calls.isEmpty, "a rejected message does nothing")
    }

    @Test func dataFolderIsRevealedOnlyWhenItExists() throws {
        let dir = try TempDir("reveal")
        #expect(DataFolder.revealable(WasitmeDirectory(dir.url)) == WasitmeDirectory(dir.url).url)
        #expect(DataFolder.revealable(WasitmeDirectory(dir.url.appendingPathComponent("nope"))) == nil)
    }
}

// MARK: the performer, with a recorded installer

/// A temp `<home>/.wasitme` with the installed copy's scripts, an engine.json, and a recorded process runner that answers
/// `--status` with `status` and every detached start with exit 0 plus a finished action record (`finish`).
@MainActor private final class Bench {
    let root: TempDir
    let directory: WasitmeDirectory
    let location: SetupLocation
    private let lock = OSAllocatedUnfairLock<[[String]]>(initialState: [])
    var status: String
    var finish: String? = #"{"schema":"wasitme.action/1","action":"add","state":"done","code":0,"summary":"Done.","pid":null,"started":"2026-10-06T10:00:00Z","finished":"2026-10-06T10:00:05Z"}"#
    var startExit: Int32 = 0
    var quits = 0
    var scans = 0
    var clears = 0
    var clearError: EngineError?
    let defaults: UserDefaults
    let suite = "wasitme-tests-\(UUID().uuidString)"

    var runs: [[String]] { lock.withLock { $0 } }
    /// Only the runs that change something (everything but `--status`).
    var changes: [[String]] { runs.filter { !$0.contains("--status") } }

    init(status: String = Bench.fullStatus) throws {
        root = try TempDir("settings")
        directory = WasitmeDirectory(root.url.appendingPathComponent(".wasitme", isDirectory: true))
        location = SetupLocation(directory: directory, userHome: URL(fileURLWithPath: "/nonexistent-home"))!
        self.status = status
        defaults = UserDefaults(suiteName: suite)!
        let lib = directory.url.appendingPathComponent("current/scripts/lib", isDirectory: true)
        try FileManager.default.createDirectory(at: lib, withIntermediateDirectories: true)
        for f in ["current/scripts/install.sh", "current/scripts/uninstall.sh", "current/scripts/lib/from-app.mjs"] {
            let url = directory.url.appendingPathComponent(f)
            try Data("# never run\n".utf8).write(to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        }
    }

    func cleanUp() { defaults.removePersistentDomain(forName: suite) }

    static let fullStatus = """
    {"schema":"wasitme.install-status/1","installed":true,"version":"0.1.0","integrations":[
     {"id":"app","state":"on"},{"id":"claude-plugin","state":"off"},{"id":"statusline","state":"own"},
     {"id":"codex-plugin","state":"unavailable","why":"agent_missing"},{"id":"scan","state":"on"}],
     "launchAtLogin":null,"update":{"available":true}}
    """

    func performer(engineConfigured: Bool = true, timeout: TimeInterval = 5) -> SettingsPerformer {
        let status = self.status, finish = self.finish, exit = startExit
        let record = location.actionRecord
        let run: SetupRunner.Run = { [lock] spec in
            lock.withLock { $0.append(spec.arguments) }
            if spec.arguments.contains("--status") {
                return ProcessResult(stdout: Data(status.utf8), stderr: Data(), status: 0, terminatedBySignal: false, duration: 0)
            }
            if exit == 0, let finish {
                try? FileManager.default.createDirectory(at: record.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? Data(finish.utf8).write(to: record, options: .atomic)
            }
            return ProcessResult(stdout: Data(), stderr: Data((exit == 0 ? "" : "error: another wasitme action started from the app is still running; nothing was started\n").utf8),
                                 status: exit, terminatedBySignal: false, duration: 0)
        }
        let clearError = self.clearError
        return SettingsPerformer(
            setup: SetupRunner(location: location, baseEnvironment: ["HOME": "/nonexistent-home"], run: run),
            clearHistory: { [weak self] in
                await MainActor.run { self?.clears += 1 }
                if let clearError { throw clearError }
                return HistoryClearResult(cleared: true, files: 2, bytes: 10)
            },
            engineConfigured: { engineConfigured },
            quit: { [weak self] in self?.quits += 1 },
            afterClear: { [weak self] in self?.scans += 1 },
            isAlive: { _ in false },
            defaults: defaults,
            timing: .init(poll: .milliseconds(10), partTimeout: timeout, updateTimeout: timeout))
    }

    func argv(_ c: SetupCommand) -> [String] { c.argv(in: location)! }
}

@Suite(.serialized) @MainActor struct SettingsPerformerTests {
    /// The whole path a click takes: the page's message, the bridge, the route, the native sheet, the performer, the
    /// installer's argv. Cancel in the sheet: no change runs at all. Yes: exactly the fixed command.
    @Test func noChangeRunsWithoutAYesInTheNativeSheet() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        let performer = bench.performer()
        await performer.refresh()
        for message: [String: Any] in [["action": "uninstallAll"], ["action": "clearHistory"], ["action": "removeIntegration", "id": "app"],
                                        ["action": "removeIntegration", "integration": "scan"], ["action": "addIntegration", "id": "claude-plugin"],
                                        ["action": "updateApp"]] {
            let no = RecordingPresenter(answer: false)
            let flow = GuardedActionFlow(performer: performer, presenter: no)
            var asked: GuardedAction?
            ControlCenterRoutes(guarded: { asked = $0 }).route(decide(message))
            let action = try #require(asked, "\(message)")
            await flow.handle(action)
            #expect(no.confirmed.count == 1 && no.informed.isEmpty, "\(message)")
        }
        #expect(bench.changes.isEmpty && bench.quits == 0 && bench.clears == 0 && bench.scans == 0)

        // yes: the exact argv, one run each
        let yes = RecordingPresenter(answer: true)
        let flow = GuardedActionFlow(performer: performer, presenter: yes)
        await flow.handle(.removeIntegration(.scan))
        await flow.handle(.addIntegration(.claudePlugin))
        #expect(bench.changes == [bench.argv(.remove(.scan)), bench.argv(.add(.claudePlugin))])
        #expect(yes.informed.isEmpty, "a change that worked shows no sheet; the page re-renders")
    }

    /// Removing the app and uninstalling quit the app once the detached run has started, and only then. The checkbox
    /// decides `--purge`.
    @Test func removingTheAppQuitsAfterTheRunStarted() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        let performer = bench.performer()
        await performer.refresh()
        await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true, option: false)).handle(.uninstallAll)
        #expect(bench.changes == [bench.argv(.uninstallAll(purge: false))] && bench.quits == 1)
        await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true, option: true)).handle(.uninstallAll)
        #expect(bench.changes.last == bench.argv(.uninstallAll(purge: true)) && bench.quits == 2)
        await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true, option: true)).handle(.removeIntegration(.app))
        #expect(bench.changes.last == bench.argv(.remove(.app)) && bench.quits == 3, "the checkbox exists only on uninstall")

        // a start that is refused (another run is going): no quit, and the sheet says nothing changed
        let refused = try Bench()
        defer { refused.cleanUp() }
        refused.startExit = 1
        let p2 = refused.performer()
        await p2.refresh()
        let presenter = RecordingPresenter(answer: true)
        await GuardedActionFlow(performer: p2, presenter: presenter).handle(.uninstallAll)
        #expect(refused.quits == 0 && presenter.informed == ["Couldn't uninstall wasitme"])
        #expect(presenter.details == ["Another wasitme action started from the app is still running; nothing was started. Nothing was changed."])
    }

    @Test func clearHistoryRunsTheEngineThenChecksAgain() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        let performer = bench.performer()
        await performer.refresh()
        await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true)).handle(.clearHistory)
        #expect(bench.clears == 1 && bench.scans == 1 && bench.changes.isEmpty)
        bench.clearError = .nonZeroExit(code: 1, stderr: "busy")
        let busy = bench.performer()
        await busy.refresh()
        let presenter = RecordingPresenter(answer: true)
        await GuardedActionFlow(performer: busy, presenter: presenter).handle(.clearHistory)
        #expect(bench.scans == 1 && presenter.informed == ["The history wasn't cleared"])
        #expect(presenter.details == ["A check was running, so nothing was deleted. Try again in a minute."])
    }

    /// Each change is offered only when the installer says it can run, with the reason when it can't.
    @Test func availabilityFollowsTheInstallersAnswer() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        let performer = bench.performer()
        #expect(performer.availability(.removeIntegration(.scan)) == .unavailable("wasitme is still reading what is installed. Try again in a moment."))
        await performer.refresh()
        #expect(performer.availability(.removeIntegration(.scan)) == .available)
        #expect(performer.availability(.addIntegration(.scan)) == .unavailable("The background scan is already on."))
        #expect(performer.availability(.addIntegration(.claudePlugin)) == .available)
        #expect(performer.availability(.removeIntegration(.claudePlugin)) == .unavailable("The Claude Code plugin is already off."))
        #expect(performer.availability(.addIntegration(.statusline)) == .unavailable("You have your own status line; wasitme leaves it alone."))
        #expect(performer.availability(.addIntegration(.codexPlugin)) == .unavailable("Codex isn't installed."))
        #expect(performer.availability(.addIntegration(.app)) == .unavailable("Only the installer adds the menu bar app."))
        #expect(performer.availability(.removeIntegration(.app)) == .available)
        #expect(performer.availability(.uninstallAll) == .available && performer.availability(.updateApp) == .available)
        #expect(performer.availability(.clearHistory) == .available)

        bench.status = #"{"schema":"wasitme.install-status/1","installed":true,"integrations":[],"update":{"available":false,"why":"no_release"}}"#
        let noRelease = bench.performer(engineConfigured: false)
        await noRelease.refresh()
        #expect(noRelease.availability(.updateApp) == .unavailable("Updates arrive with the first public release."))
        #expect(noRelease.availability(.clearHistory) == .unavailable("wasitme's engine isn't set up, so there is no saved history to clear."))
        #expect(noRelease.availability(.removeIntegration(.scan)) == .unavailable("wasitme couldn't read whether it is installed."))

        bench.status = #"{"schema":"wasitme.install-status/1","installed":false,"integrations":[{"id":"scan","state":"unknown","why":"no_install_record"}]}"#
        let notInstalled = bench.performer()
        await notInstalled.refresh()
        #expect(notInstalled.availability(.uninstallAll) == .unavailable("No install record; run the installer once."))

        bench.status = "garbage"
        let unanswered = bench.performer()
        await unanswered.refresh()
        #expect(unanswered.availability(.uninstallAll) == .unavailable("wasitme couldn't read what is installed. Open Settings again to retry."))

        // a folder its installer doesn't manage: only Clear History
        let custom = SettingsPerformer(setup: nil, clearHistory: { HistoryClearResult(cleared: false, files: 0, bytes: 0) },
                                       engineConfigured: { true }, quit: {}, afterClear: {})
        await custom.refresh()
        #expect(custom.availability(.uninstallAll) == .unavailable("This copy of wasitme reads a folder its installer doesn't manage."))
        #expect(custom.availability(.clearHistory) == .available)
    }

    /// One change at a time: while one runs (here, or one another copy of the app started), nothing else is offered,
    /// and the page is told what is running.
    @Test func oneChangeAtATime() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        bench.finish = nil      // the run never finishes within the test's timeout
        let performer = bench.performer(timeout: 0.5)
        await performer.refresh()
        var busyWords: [String?] = []
        performer.onChange = { busyWords.append(performer.state(desktopPanel: false, launchAtLogin: .off).busy) }
        let consentTask = Task { await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true)).handle(.addIntegration(.claudePlugin)) }
        #expect(await eventually { performer.running != nil })
        #expect(performer.availability(.uninstallAll) == .unavailable("Another change is still running. Try again when it has finished."))
        #expect(performer.state(desktopPanel: false, launchAtLogin: .off).busy == "claude-plugin")
        await consentTask.value
        #expect(performer.running == nil && busyWords.contains("claude-plugin") && busyWords.last == .some(nil))

        // another copy's run, still going (no pid yet, started just now)
        let started = ContractDate.format(Date())
        try FileManager.default.createDirectory(at: bench.location.actionRecord.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"schema":"wasitme.action/1","action":"update","state":"running","code":null,"summary":"","pid":null,"started":"\#(started)","finished":null}"#.utf8)
            .write(to: bench.location.actionRecord)
        let other = bench.performer()
        await other.refresh()
        #expect(other.otherRun == .update && other.state(desktopPanel: true, launchAtLogin: .on).busy == "updateApp")
        #expect(other.availability(.clearHistory) == .unavailable("Another change is still running. Try again when it has finished."))
    }

    /// What the user sees once a run has ended.
    @Test func resultsOfEachOutcome() {
        typealias P = SettingsPerformer
        #expect(P.result(of: .done("Added."), for: .addIntegration(.scan)) == .done)
        #expect(P.result(of: .done("Updated to 0.2.0."), for: .updateApp) == .report("wasitme was updated", detail: "Updated to 0.2.0."))
        #expect(P.result(of: .stopped("The plugin adds a hook."), for: .updateApp) == .confirmNext(.updateAcceptingPluginChanges, note: "The plugin adds a hook."))
        #expect(P.result(of: .stopped("x"), for: .updateAcceptingPluginChanges) == .failed("Couldn't update wasitme", detail: "X. Nothing was changed."), "the line is capitalised and ends a sentence")
        #expect(P.result(of: .partial("Plugin failed."), for: .addIntegration(.claudePlugin))
                == .failed("Couldn't add the Claude Code plugin", detail: "Plugin failed. That part was undone, and nothing else was changed."))
        #expect(P.result(of: .failed(code: 1, "Claude Code isn't installed."), for: .addIntegration(.claudePlugin))
                == .failed("Couldn't add the Claude Code plugin", detail: "Claude Code isn't installed. Nothing was changed."))
        // the installer's own refusal line (seen in a sandbox install: --add claude-plugin without the claude command)
        #expect(P.result(of: .failed(code: 1, "error: Claude Code plugin was requested but is not possible here: the 'claude' command was not found"),
                         for: .addIntegration(.claudePlugin))
                == .failed("Couldn't add the Claude Code plugin",
                           detail: "Claude Code plugin was requested but is not possible here: the 'claude' command was not found. Nothing was changed."))
        #expect(P.result(of: .failed(code: 1, "Not removed."), for: .removeIntegration(.statusline))
                == .failed("Couldn't remove the status line", detail: "Not removed."), "a failed remove claims nothing about what changed")
        #expect(P.result(of: .failed(code: 7, ""), for: .removeIntegration(.scan)) == .failed("Couldn't turn off the background scan", detail: "It stopped with exit code 7."))
        if case .failed(let t, _) = P.result(of: .cutShort, for: .updateApp) { #expect(t == "Couldn't update wasitme") } else { Issue.record("cutShort") }
        if case .report(let t, _) = P.result(of: .timedOut, for: .addIntegration(.scan)) { #expect(t == "Still working") } else { Issue.record("timedOut") }
        #expect(P.result(of: .missing, for: .removeIntegration(.scan)) == .done)
    }

    /// An update that stopped because the new plugin asks for more: the app asks again, naming that, and only a second
    /// yes runs it with `--accept-plugin-changes`.
    @Test func aStoppedUpdateAsksAgain() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        bench.finish = #"{"schema":"wasitme.action/1","action":"update","state":"stopped","code":4,"summary":"The new plugin adds a SessionStart hook.","pid":null,"started":"2026-10-06T10:00:00Z","finished":"2026-10-06T10:00:05Z"}"#
        let performer = bench.performer()
        await performer.refresh()
        let sequence = SequencePresenter(answers: [true, false])
        await GuardedActionFlow(performer: performer, presenter: sequence).handle(.updateApp)
        #expect(sequence.confirmed.map(\.question) == ["Update wasitme?", "Update with the new plugin?"])
        #expect(sequence.confirmed.last?.detail.contains("The new plugin adds a SessionStart hook.") == true)
        #expect(bench.changes == [bench.argv(.update(acceptPluginChanges: false))], "the second No ran nothing")
        let again = SequencePresenter(answers: [true, true])
        await GuardedActionFlow(performer: performer, presenter: again).handle(.updateApp)
        #expect(bench.changes.suffix(2) == [bench.argv(.update(acceptPluginChanges: false)), bench.argv(.update(acceptPluginChanges: true))])
    }

    /// After the installer quit and reopened the app, an update's result is shown once, and only a recent one.
    @Test func anUpdatesResultIsShownOnceAfterTheRelaunch() async throws {
        let bench = try Bench()
        defer { bench.cleanUp() }
        let now = Date()
        func record(_ state: String, finished: Date) throws {
            try FileManager.default.createDirectory(at: bench.location.actionRecord.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(#"{"schema":"wasitme.action/1","action":"update","state":"\#(state)","code":\#(state == "done" ? 0 : 1),"summary":"Updated to 0.2.0.","pid":null,"started":"\#(ContractDate.format(finished.addingTimeInterval(-60)))","finished":"\#(ContractDate.format(finished))"}"#.utf8)
                .write(to: bench.location.actionRecord, options: .atomic)
        }
        try record("done", finished: now.addingTimeInterval(-120))
        let p = bench.performer()
        await p.refresh()
        let shown = try #require(p.takeUnreportedUpdate())
        #expect(shown.text == "wasitme was updated" && shown.detail == "Updated to 0.2.0.")
        #expect(p.takeUnreportedUpdate() == nil, "once")
        let p2 = bench.performer()
        await p2.refresh()
        #expect(p2.takeUnreportedUpdate() == nil, "remembered across launches")
        try record("failed", finished: now.addingTimeInterval(-2 * 86_400))
        let old = bench.performer()
        await old.refresh()
        #expect(old.takeUnreportedUpdate() == nil, "not one from days ago")
        try record("failed", finished: now.addingTimeInterval(3600))
        let future = bench.performer()
        await future.refresh()
        #expect(future.takeUnreportedUpdate() == nil, "not one the clock places in the future")
    }
}

/// Answers each confirmation from a list (yes, then no, ...); records the sheets.
@MainActor final class SequencePresenter: AlertPresenting {
    var answers: [Bool]
    var confirmed: [GuardedConfirmation] = []
    var informed: [String] = []
    init(answers: [Bool]) { self.answers = answers }
    func inform(_ text: String, detail: String?) { informed.append(text) }
    func confirm(_ c: GuardedConfirmation) async -> GuardedConfirmation.Answer {
        confirmed.append(c)
        return answers.isEmpty ? .cancel : (answers.removeFirst() ? .confirm(option: false) : .cancel)
    }
}

@Suite @MainActor struct GuardedFlowTests {
    /// The checkbox reaches the performer only from a sheet that has one.
    @Test func theOptionComesOnlyFromTheSheetsCheckbox() async {
        let performer = RecordingPerformer()
        await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true, option: true)).handle(.uninstallAll)
        await GuardedActionFlow(performer: performer, presenter: RecordingPresenter(answer: true, option: true)).handle(.clearHistory)
        #expect(performer.consents.map(\.option) == [true, false])
    }

    /// If the change can't run any more once the sheet closes (another started meanwhile), it says so and runs nothing.
    @Test func availabilityIsCheckedAgainAfterTheSheet() async {
        let performer = FlippingPerformer()
        let presenter = RecordingPresenter(answer: true)
        await GuardedActionFlow(performer: performer, presenter: presenter).handle(.removeIntegration(.scan))
        #expect(performer.performed == 0 && presenter.confirmed.count == 1)
        #expect(presenter.informed == ["wasitme can't turn off the background scan right now"])
        #expect(presenter.details == ["Another change is still running. Nothing was changed."])
    }

    /// A reason replaces the Terminal steps; without one, the Terminal steps are the fallback.
    @Test func unavailableSheetsGiveTheReason() {
        #expect(GuardedPlan.plan(.updateApp, availability: .unavailable("Updates arrive with the first public release."))
                == .inform(heading: "wasitme can't update wasitme right now", detail: "Updates arrive with the first public release. Nothing was changed."))
        #expect(GuardedPlan.plan(.clearHistory, availability: .unavailable(nil))
                == .inform(heading: GuardedAction.clearHistory.heading, detail: GuardedAction.clearHistory.terminalSteps))
    }

    /// UX-V2 §9.3: every destructive sheet says what happens and what is kept, within 45 words; uninstall has the
    /// history checkbox, off by default.
    @Test func confirmationWords() {
        for a in GuardedAction.all + [.updateAcceptingPluginChanges] {
            let c = a.confirmation
            let words = c.detail.split(whereSeparator: \.isWhitespace).count
            #expect(words <= 45, "\(a): \(words) words")
            if a.isDestructive { #expect(c.detail.contains("stay") || c.detail.contains("kept") || c.detail.contains("never touched"), "\(a)") }
            #expect((c.option != nil) == (a == .uninstallAll), "\(a)")
        }
        #expect(GuardedAction.uninstallAll.confirmation.option == "Also delete my saved history")
        #expect(GuardedAction.removeIntegration(.scan).confirmation.button == "Turn Off" && GuardedAction.addIntegration(.scan).confirmation.button == "Turn On")
        #expect(GuardedAction.clearHistory.confirmation.button == "Clear History")
    }
}

@Suite @MainActor struct ConfirmationAlertTests {
    /// The NSAlert each confirmation becomes (built, never shown): the confirming button first; a destructive one marked
    /// so with Return on Cancel; a constructive one keeps Return; the uninstall checkbox is there and off.
    @Test func theRealAlertForEachConfirmation() throws {
        _ = Headless.ready
        for a in GuardedAction.all + [.updateAcceptingPluginChanges] {
            let c = a.confirmation(note: "Note.")
            let (alert, box) = WindowAlertPresenter.alert(for: c)
            #expect(alert.messageText == c.question && alert.informativeText == c.detail, "\(a)")
            let buttons = alert.buttons
            try #require(buttons.count == 2)
            #expect(buttons[0].title == c.button && buttons[1].title == "Cancel", "\(a)")
            #expect(buttons[0].hasDestructiveAction == a.isDestructive, "\(a)")
            if a.isDestructive {
                #expect(buttons[1].keyEquivalent == "\r" && buttons[0].keyEquivalent.isEmpty, "\(a): Return answers Cancel")
                #expect(alert.alertStyle == .warning)
            } else {
                #expect(buttons[0].keyEquivalent == "\r", "\(a): Return confirms a change that removes nothing")
            }
            #expect((box != nil) == (a == .uninstallAll) && box?.state != .on && alert.accessoryView === box, "\(a)")
            #expect(!alert.window.isVisible)
        }
    }
}

/// Available when asked first, busy by the time the sheet has closed.
@MainActor private final class FlippingPerformer: GuardedActionPerforming {
    var asked = 0
    var performed = 0
    func availability(_ action: GuardedAction) -> GuardedAvailability {
        asked += 1
        return asked == 1 ? .available : .unavailable("Another change is still running.")
    }
    func perform(_ consent: GuardedConsent) async -> GuardedActionResult { performed += 1; return .done }
}
