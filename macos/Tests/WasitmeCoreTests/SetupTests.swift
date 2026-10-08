import Darwin
import Foundation
import os
import Testing
@testable import WasitmeCore

// The Settings page's backend in WasitmeCore: the installer/uninstaller argv, the status and action-record documents,
// and the runner that starts and follows them. No test here runs an installer against a real home: the runner's process
// is a recording stand-in, and the one real-script test points the repository's installer at an empty temp home.

/// A temp `<home>/.wasitme` holding the installed copy's scripts (as the installer leaves them: 0644, owned by us).
private struct FakeInstall {
    let root: TempDir
    var home: URL { root.url }
    var directory: WasitmeDirectory { WasitmeDirectory(root.url.appendingPathComponent(".wasitme", isDirectory: true)) }
    var location: SetupLocation { SetupLocation(directory: directory, userHome: URL(fileURLWithPath: "/nonexistent-home"))! }

    init(scripts: Bool = true) throws {
        root = try TempDir("setup")
        guard scripts else { return }
        let lib = directory.url.appendingPathComponent("current/scripts/lib", isDirectory: true)
        try FileManager.default.createDirectory(at: lib, withIntermediateDirectories: true)
        for f in ["current/scripts/install.sh", "current/scripts/uninstall.sh", "current/scripts/lib/from-app.mjs"] {
            let url = directory.url.appendingPathComponent(f)
            try Data("# not run by these tests\n".utf8).write(to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        }
    }

    func writeRecord(_ json: String) throws {
        let state = directory.url.appendingPathComponent("state", isDirectory: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: state.appendingPathComponent("last-action.json"), options: .atomic)
    }

    func removeRecord() { try? FileManager.default.removeItem(at: location.actionRecord) }
}

/// Records every process the runner would start and answers as told; never starts one.
private final class RecordingRun: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<[ProcessSpec]>(initialState: [])
    let answer: @Sendable (ProcessSpec) -> ProcessResult
    init(_ answer: @escaping @Sendable (ProcessSpec) -> ProcessResult) { self.answer = answer }
    var specs: [ProcessSpec] { lock.withLock { $0 } }
    var run: SetupRunner.Run {
        { [self] spec in lock.withLock { $0.append(spec) }; return answer(spec) }
    }
}

private func result(_ status: Int32, stdout: String = "", stderr: String = "", signal: Bool = false) -> ProcessResult {
    ProcessResult(stdout: Data(stdout.utf8), stderr: Data(stderr.utf8), status: status, terminatedBySignal: signal, duration: 0)
}

private let statusJSON = """
{
  "schema": "wasitme.install-status/1",
  "installed": true,
  "version": "0.1.0",
  "integrations": [
    { "id": "app", "state": "on" },
    { "id": "claude-plugin", "state": "on" },
    { "id": "statusline", "state": "own" },
    { "id": "codex-plugin", "state": "unavailable", "why": "agent_missing" },
    { "id": "scan", "state": "off" }
  ],
  "launchAtLogin": null,
  "update": { "available": false, "why": "no_release" }
}
"""

@Suite struct SetupCommandTests {
    /// Every command is `/bin/sh <wasitme>/current/scripts/<script> <fixed flags>`, built from the closed id enum.
    @Test func argvIsFixedPerCommand() throws {
        let f = try FakeInstall()
        let s = f.location.scriptsDirectory.path
        let home = ["--home", f.home.standardizedFileURL.path]
        let want: [(SetupCommand, [String])] = [
            (.status, ["\(s)/install.sh", "--status", "--json"]),
            (.add(.claudePlugin), ["\(s)/install.sh", "--add", "claude-plugin", "--from-app"]),
            (.add(.scan), ["\(s)/install.sh", "--add", "scan", "--from-app"]),
            (.add(.statusline), ["\(s)/install.sh", "--add", "statusline", "--from-app"]),
            (.add(.codexPlugin), ["\(s)/install.sh", "--add", "codex-plugin", "--from-app"]),
            (.remove(.app), ["\(s)/uninstall.sh", "--yes", "--only", "app", "--from-app"]),
            (.remove(.scan), ["\(s)/uninstall.sh", "--yes", "--only", "scan", "--from-app"]),
            (.remove(.statusline), ["\(s)/uninstall.sh", "--yes", "--only", "statusline", "--from-app"]),
            (.uninstallAll(purge: false), ["\(s)/uninstall.sh", "--yes", "--from-app"]),
            (.uninstallAll(purge: true), ["\(s)/uninstall.sh", "--yes", "--purge", "--from-app"]),
            (.update(acceptPluginChanges: false), ["\(s)/install.sh", "--update", "--from-app"]),
            (.update(acceptPluginChanges: true), ["\(s)/install.sh", "--update", "--accept-plugin-changes", "--from-app"]),
        ]
        for (command, argv) in want {
            #expect(command.argv(in: f.location) == argv + home, "\(command)")
        }
        #expect(SetupCommand.shell.path == "/bin/sh")
        #expect(f.location.scriptsDirectory.path == f.directory.url.path + "/current/scripts")
    }

    /// `--home` only for a folder that is not the user's own `~/.wasitme` (it puts the installer in sandbox mode, which
    /// never touches launchd); a folder not named `.wasitme` can't be managed at all.
    @Test func homeFlagOnlyOutsideTheUsersOwnFolder() {
        let user = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
        let own = SetupLocation(directory: .standard(home: user), userHome: user)
        #expect(own?.homeArguments == [])
        #expect(own.flatMap { SetupCommand.status.argv(in: $0) } == ["/Users/someone/.wasitme/current/scripts/install.sh", "--status", "--json"])
        let elsewhere = SetupLocation(directory: WasitmeDirectory(URL(fileURLWithPath: "/tmp/sandbox/.wasitme")), userHome: user)
        #expect(elsewhere?.homeArguments == ["--home", "/tmp/sandbox"])
        #expect(SetupLocation(directory: WasitmeDirectory(URL(fileURLWithPath: "/tmp/custom-home")), userHome: user) == nil)
        #expect(SetupLocation(directory: WasitmeDirectory(URL(fileURLWithPath: "/tmp/a\nb/.wasitme")), userHome: user) == nil)
    }

    @Test func onlyTheInstallerAddsTheApp() throws {
        let f = try FakeInstall()
        #expect(SetupCommand.add(.app).argv(in: f.location) == nil && !SetupCommand.add(.app).isSupported)
        #expect(IntegrationID.allCases.filter { !$0.canBeAddedFromInstalledCopy } == [.app])
    }

    @Test func whatEachCommandDoesToTheApp() {
        #expect(!SetupCommand.status.runsDetached)
        for c: SetupCommand in [.add(.scan), .remove(.statusline), .remove(.app), .uninstallAll(purge: false), .update(acceptPluginChanges: false)] {
            #expect(c.runsDetached && c.arguments.last == "--from-app", "\(c)")
        }
        #expect(SetupCommand.remove(.app).quitsApp && SetupCommand.uninstallAll(purge: true).quitsApp)
        #expect(!SetupCommand.remove(.scan).quitsApp && !SetupCommand.update(acceptPluginChanges: false).quitsApp
                && !SetupCommand.add(.claudePlugin).quitsApp)
    }

    /// The page's ids: the installer's own, plus `scan-agent` for the scan. Nothing else.
    @Test func integrationIDsFromThePage() {
        #expect(IntegrationID(bridgeValue: "scan-agent") == .scan && IntegrationID(bridgeValue: "scan") == .scan)
        for raw in ["claude-plugin", "codex-plugin", "statusline", "app"] { #expect(IntegrationID(bridgeValue: raw)?.rawValue == raw) }
        for raw in ["", "Scan", "mcp", "../app", "app ", "scan-agent2"] { #expect(IntegrationID(bridgeValue: raw) == nil, "\(raw)") }
        #expect(IntegrationID.displayOrder.map(\.rawValue) == ["app", "claude-plugin", "statusline", "codex-plugin", "scan"])
    }

    /// A script is run only when it is a regular file of ours that nobody else can write.
    @Test func scriptsMustBeOursAndNotWritableByOthers() throws {
        let f = try FakeInstall()
        let script = f.location.installScript
        #expect(ScriptFile.isTrusted(script) && f.location.scriptsPresent)
        try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: script.path)
        #expect(!ScriptFile.isTrusted(script) && !f.location.scriptsPresent)
        try FileManager.default.setAttributes([.posixPermissions: 0o664], ofItemAtPath: script.path)
        #expect(!ScriptFile.isTrusted(script))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: script.path)
        #expect(!ScriptFile.isTrusted(f.location.scriptsDirectory), "a folder is not a script")
        #expect(!ScriptFile.isTrusted(f.location.scriptsDirectory.appendingPathComponent("missing.sh")))
        // `current` is a symlink in a real install: followed
        let link = f.home.appendingPathComponent("link.sh")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: script)
        #expect(ScriptFile.isTrusted(link))
        #expect(!(try FakeInstall(scripts: false)).location.scriptsPresent)
    }
}

@Suite struct InstallStatusTests {
    @Test func readsTheInstallersAnswer() {
        let s = InstallStatus.parse(Data(statusJSON.utf8))
        #expect(s.answered && s.installed && s.version == "0.1.0")
        #expect(s.parts.map(\.id) == IntegrationID.displayOrder)
        #expect(s.part(.app) == .init(id: .app, state: .on))
        #expect(s.part(.statusline).state == .own)
        #expect(s.part(.codexPlugin) == .init(id: .codexPlugin, state: .unavailable, why: .agentMissing))
        #expect(s.part(.scan).state == .off)
        #expect(!s.updateAvailable && s.updateWhy == .noRelease)
    }

    /// Unknown words never become a state the page would act on.
    @Test func readsTolerantly() {
        let doc = """
        {"schema":"wasitme.install-status/1.2","installed":1,"version":"0.1.0; rm -rf /",
         "integrations":[{"id":"app","state":"maybe"},{"id":"mcp","state":"on"},{"id":"scan","state":"on","why":"because"},
                         {"id":"scan","state":"off"},{"id":"statusline"},"junk",{"id":7,"state":"on"}],
         "update":{"available":"yes"}}
        """
        let s = InstallStatus.parse(Data(doc.utf8))
        #expect(s.answered && !s.installed, "installed must be a JSON boolean")
        #expect(s.version == nil)
        #expect(s.part(.app).state == .unknown)
        #expect(s.part(.scan) == .init(id: .scan, state: .on), "the first entry for an id wins; an unknown why is dropped")
        #expect(s.part(.statusline).state == .unknown && s.part(.claudePlugin).state == .unknown && s.part(.codexPlugin).state == .unknown)
        #expect(s.parts.count == 5 && !s.updateAvailable)
        let available = InstallStatus.parse(Data(#"{"schema":"wasitme.install-status/1","installed":true,"update":{"available":true,"why":"no_release"}}"#.utf8))
        #expect(available.updateAvailable && available.updateWhy == nil)
    }

    @Test(arguments: ["", "null", "[]", "{}", #"{"schema":"wasitme.install-status/2","installed":true}"#,
                      #"{"schema":"wasitme.engine/1","installed":true}"#, "not json"])
    func anythingElseIsUnknown(_ text: String) {
        let s = InstallStatus.parse(Data(text.utf8))
        #expect(s == .unknown && !s.answered && s.parts.allSatisfy { $0.state == .unknown })
    }

    /// The repository's own installer, asked about an empty temp home (no install record): the answer this parser reads.
    /// Reads only; `--home` keeps it off the real `~/.wasitme` and off launchd.
    @Test func theRealInstallersAnswerWithoutAnInstall() async throws {
        let home = try TempDir("status-real")
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("scripts/install.sh")
        let r = try await ProcessRunner.run(ProcessSpec(
            executable: URL(fileURLWithPath: "/bin/sh"), arguments: [script.path, "--status", "--json", "--home", home.url.path],
            environment: ["PATH": "/usr/bin:/bin", "HOME": home.url.path], timeout: 30))
        #expect(r.status == 0, "\(String(decoding: r.stderr, as: UTF8.self))")
        let s = InstallStatus.parse(r.stdout)
        #expect(s.answered && !s.installed && s.version == nil, "\(String(decoding: r.stdout, as: UTF8.self))")
        #expect(s.parts == InstallStatus.notInstalled.parts, "every part unknown, no_install_record, in display order")
        // The public export fills in the owner, which gives the installer a release URL; spelled in pieces so the
        // export does not rewrite this check.
        if try String(contentsOf: script, encoding: .utf8).contains("OWNER" + "/wasitme") {
            #expect(!s.updateAvailable && s.updateWhy == .noRelease, "the repository's installer has no release URL yet")
        } else {
            #expect(s.updateAvailable, "the public tree's installer has a release URL")
        }
        #expect(!FileManager.default.fileExists(atPath: home.url.appendingPathComponent(".wasitme").path), "it only read")
    }
}

@Suite struct ActionRecordTests {
    private func record(_ state: String, pid: String = "null", code: String = "null", started: String = "\"2026-10-06T10:00:00.000Z\"") -> ActionRecord? {
        ActionRecord.parse(Data("""
        {"schema":"wasitme.action/1","action":"add","state":"\(state)","code":\(code),"summary":"Added the status line.",
         "pid":\(pid),"started":\(started),"finished":null}
        """.utf8))
    }

    @Test func readsWhatFromAppWrites() throws {
        let r = try #require(record("done", code: "0"))
        #expect(r.kind == .add && r.state == .done && r.code == 0 && r.summary == "Added the status line." && r.pid == nil)
        #expect(r.started == "2026-10-06T10:00:00.000Z")
        #expect(record("running", pid: "4242")?.pid == 4242)
        for bad in [#"{"schema":"wasitme.action/2","action":"add","state":"done"}"#, #"{"schema":"wasitme.action/1","action":"rm","state":"done"}"#,
                    #"{"schema":"wasitme.action/1","action":"add","state":"weird"}"#, "[]", ""] {
            #expect(ActionRecord.parse(Data(bad.utf8)) == nil, "\(bad)")
        }
        #expect(record("running", pid: "-5")?.pid == nil && record("running", pid: "true")?.pid == nil)
        #expect(record("failed", code: "true")?.code == nil)
    }

    @Test func outcomes() throws {
        let alive: (pid_t) -> Bool = { _ in true }, dead: (pid_t) -> Bool = { _ in false }
        #expect(try #require(record("running", pid: "77")).outcome(isAlive: alive) == .running)
        #expect(try #require(record("running", pid: "77")).outcome(isAlive: dead) == .cutShort)
        #expect(try #require(record("running")).outcome(isAlive: dead) == .starting)
        #expect(try #require(record("done", code: "0")).outcome(isAlive: dead) == .done("Added the status line."))
        #expect(try #require(record("partial", code: "3")).outcome(isAlive: dead) == .partial("Added the status line."))
        #expect(try #require(record("stopped", code: "4")).outcome(isAlive: dead) == .stopped("Added the status line."))
        #expect(try #require(record("failed", code: "1")).outcome(isAlive: dead) == .failed(code: 1, "Added the status line."))
        #expect(!ActionOutcome.running.isFinal && !ActionOutcome.starting.isFinal && ActionOutcome.cutShort.isFinal)
    }

    /// Busy for anyone looking: a live pid, or no pid yet within a minute of its start (a clock that went backward is not
    /// "recent").
    @Test func busyForOthers() throws {
        let start = try #require(ContractDate.parse("2026-10-06T10:00:00.000Z"))
        let pending = try #require(record("running"))
        #expect(pending.isBusy(now: start.addingTimeInterval(10), isAlive: { _ in false }))
        #expect(!pending.isBusy(now: start.addingTimeInterval(61), isAlive: { _ in false }))
        #expect(!pending.isBusy(now: start.addingTimeInterval(-30), isAlive: { _ in false }))
        #expect(try #require(record("running", pid: "9")).isBusy(now: start.addingTimeInterval(3600), isAlive: { _ in true }))
        #expect(!(try #require(record("running", pid: "9")).isBusy(now: start, isAlive: { _ in false })))
        #expect(!(try #require(record("done", code: "0")).isBusy(now: start, isAlive: { _ in true })))
    }

    @Test func livenessOfRealProcesses() {
        #expect(ProcessLiveness.isAlive(getpid()))
        #expect(!ProcessLiveness.isAlive(0) && !ProcessLiveness.isAlive(-1))
    }
}

@Suite(.serialized) struct SetupRunnerTests {
    /// The environment is built from nothing: the engine's variables only (no secrets from the app's own environment),
    /// node's folder first on PATH when engine.json names one.
    @Test func environmentIsBuiltFromNothing() throws {
        let f = try FakeInstall()
        let base = ["HOME": "/Users/someone", "OPENAI_API_KEY": "sk-secret", "PATH": "/evil:/usr/bin", "CODEX_HOME": "/x/codex"]
        let runner = SetupRunner(location: f.location, baseEnvironment: base, run: RecordingRun { _ in result(0) }.run)
        let env = try #require(runner.spec(.status)).environment
        #expect(env["OPENAI_API_KEY"] == nil && env["HOME"] == "/Users/someone" && env["CODEX_HOME"] == "/x/codex")
        #expect(env["PATH"] == "/usr/bin:/bin", "no engine.json: system tools only")
        // with a usable engine.json, node's own folder leads (from-app.mjs runs on it)
        let node = f.directory.url.appendingPathComponent("node-bin/node")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let cli = f.directory.url.appendingPathComponent("cli.js")
        try Data("//\n".utf8).write(to: cli)
        try Data(#"{"node":"\#(node.path)","cli":"\#(cli.path)"}"#.utf8).write(to: f.directory.engineConfigURL)
        #expect(try #require(runner.spec(.status)).environment["PATH"] == "\(node.deletingLastPathComponent().path):/usr/bin:/bin")
        let spec = try #require(runner.spec(.remove(.scan)))
        #expect(spec.executable.path == "/bin/sh" && spec.timeout == 30 && spec.maxOutputBytes == 256 * 1024)
        #expect(runner.spec(.add(.app)) == nil)
    }

    @Test func statusComesFromTheInstaller() async throws {
        let f = try FakeInstall()
        let ok = RecordingRun { _ in result(0, stdout: statusJSON) }
        #expect(await SetupRunner(location: f.location, run: ok.run).readStatus().part(.scan).state == .off)
        #expect(ok.specs.map(\.arguments) == [SetupCommand.status.argv(in: f.location)!])
        for bad in [result(1, stdout: statusJSON), result(9, signal: true), result(0, stdout: "nope")] {
            #expect(await SetupRunner(location: f.location, run: RecordingRun { _ in bad }.run).readStatus() == .unknown)
        }
        // no installed copy of the scripts: nothing is run, and the answer is the installer's own "no install record"
        let none = try FakeInstall(scripts: false)
        let never = RecordingRun { _ in result(0, stdout: statusJSON) }
        #expect(await SetupRunner(location: none.location, run: never.run).readStatus() == .notInstalled)
        #expect(never.specs.isEmpty)
    }

    @Test func startSaysOnlyWhetherItStarted() async throws {
        let f = try FakeInstall()
        #expect(await SetupRunner(location: f.location, run: RecordingRun { _ in result(0, stdout: "Started in the background") }.run)
            .start(.add(.scan)) == .started)
        let busy = RecordingRun { _ in result(1, stderr: "error: another wasitme action started from the app is still running; nothing was started\n") }
        #expect(await SetupRunner(location: f.location, run: busy.run).start(.remove(.statusline))
            == .refused("Another wasitme action started from the app is still running; nothing was started"))
        #expect(await SetupRunner(location: f.location, run: RecordingRun { _ in result(2) }.run).start(.update(acceptPluginChanges: false))
            == .refused("It could not be started."))
        let never = RecordingRun { _ in result(0) }
        #expect(await SetupRunner(location: f.location, run: never.run).start(.status) == .unavailable, "status is not detached")
        #expect(await SetupRunner(location: f.location, run: never.run).start(.add(.app)) == .unavailable)
        #expect(await SetupRunner(location: try FakeInstall(scripts: false).location, run: never.run).start(.add(.scan)) == .unavailable)
        #expect(never.specs.isEmpty)
    }

    @Test func followsTheRecordUntilTheRunEnds() async throws {
        let f = try FakeInstall()
        let runner = SetupRunner(location: f.location, run: RecordingRun { _ in result(0) }.run)
        try f.writeRecord(#"{"schema":"wasitme.action/1","action":"add","state":"running","code":null,"summary":"","pid":null,"started":"2026-10-06T10:00:00Z","finished":null}"#)
        let writer = Task {
            try? await Task.sleep(for: .milliseconds(60))
            try? f.writeRecord(#"{"schema":"wasitme.action/1","action":"add","state":"running","code":null,"summary":"","pid":4242,"started":"2026-10-06T10:00:00Z","finished":null}"#)
            try? await Task.sleep(for: .milliseconds(60))
            try? f.writeRecord(#"{"schema":"wasitme.action/1","action":"add","state":"done","code":0,"summary":"Added the scan.","pid":null,"started":"2026-10-06T10:00:00Z","finished":"2026-10-06T10:00:09Z"}"#)
        }
        let outcome = await runner.waitForOutcome(timeout: 10, interval: .milliseconds(10), isAlive: { _ in true })
        await writer.value
        #expect(outcome == .done("Added the scan."))
    }

    @Test func aRunWhoseProcessIsGoneWasCutShort() async throws {
        let f = try FakeInstall()
        let runner = SetupRunner(location: f.location, run: RecordingRun { _ in result(0) }.run)
        try f.writeRecord(#"{"schema":"wasitme.action/1","action":"update","state":"running","code":null,"summary":"","pid":4242,"started":"2026-10-06T10:00:00Z","finished":null}"#)
        #expect(await runner.waitForOutcome(timeout: 10, interval: .milliseconds(10), isAlive: { _ in false }) == .cutShort)
        // never picked up by its second stage
        try f.writeRecord(#"{"schema":"wasitme.action/1","action":"update","state":"running","code":null,"summary":"","pid":null,"started":"2026-10-06T10:00:00Z","finished":null}"#)
        #expect(await runner.waitForOutcome(timeout: 10, interval: .milliseconds(10), startGrace: 0.05, isAlive: { _ in true }) == .cutShort)
    }

    @Test func givesUpAtTheTimeoutAndNoticesADeletedRecord() async throws {
        let f = try FakeInstall()
        let runner = SetupRunner(location: f.location, run: RecordingRun { _ in result(0) }.run)
        try f.writeRecord(#"{"schema":"wasitme.action/1","action":"remove","state":"running","code":null,"summary":"","pid":4242,"started":"2026-10-06T10:00:00Z","finished":null}"#)
        #expect(await runner.waitForOutcome(timeout: 0.05, interval: .milliseconds(10), isAlive: { _ in true }) == .timedOut)
        let deleter = Task {
            try? await Task.sleep(for: .milliseconds(50))
            f.removeRecord()
        }
        #expect(await runner.waitForOutcome(timeout: 10, interval: .milliseconds(10), isAlive: { _ in true }) == .missing)
        await deleter.value
    }

    @Test func reasonsAreTheScriptsLastLineCleaned() {
        #expect(SetupRunner.reason(Data("warn: x\nerror: could not use /tmp/x; nothing was started\n\n".utf8)) == "Could not use /tmp/x; nothing was started")
        #expect(SetupRunner.reason(Data("\u{1b}[31mred\u{1b}[0m\n".utf8)) == "Red")
        #expect(SetupRunner.reason(Data()) == nil && SetupRunner.reason(Data("\n \n".utf8)) == nil)
    }
}
