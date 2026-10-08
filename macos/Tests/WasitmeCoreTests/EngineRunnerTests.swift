import Foundation
import Testing
@testable import WasitmeCore

/// A throwaway "installed engine": `node` is a shell script that stands in for the real binary
/// (the runner exec()s it directly, exactly as it would exec node), and `cli` is a plain file.
private struct FakeEngine {
    let home: TempDir
    var directory: WasitmeDirectory { WasitmeDirectory(home.url) }
    var node: URL { home.file("fake-node") }
    var cli: URL { home.file("cli.js") }
    var marker: URL { home.file("marker") }
    var markerLineCount: Int {
        ((try? String(contentsOf: marker, encoding: .utf8)) ?? "").split(whereSeparator: \.isNewline).count
    }
    var markerPID: pid_t? {
        (try? String(contentsOf: marker, encoding: .utf8)).flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /// - Parameter nodeBody: shell script body; `$@` is `<cli> <action> [args] --json`.
    init(nodeBody: String) throws {
        home = try TempDir("engine")
        // "@MARKER@" in a script body becomes this engine's own marker file (removed with the temp dir).
        let body = nodeBody.replacingOccurrences(of: "@MARKER@", with: home.file("marker").path)
        try home.write("fake-node", "#!/bin/sh\n\(body)\n", executable: true)
        try home.write("cli.js", "// not executed by the fake node\n")
        try writeConfig()
    }

    func writeConfig(node: String? = nil, cli: String? = nil, extra: String = "") throws {
        let json = """
        {"schema":"wasitme.engine/1","node":"\(node ?? self.node.path)","cli":"\(cli ?? self.cli.path)","version":"0.0.0-test"\(extra)}
        """
        try home.write("engine.json", json)
    }

    func runner(timeout: TimeInterval = 20, grace: TimeInterval = 0.5, maxOutput: Int = 8 * 1024 * 1024,
                env: [String: String] = ["HOME": "/home/test", "PATH": "/should/not/leak"]) -> EngineRunner {
        EngineRunner(directory: directory, timeout: timeout, maxOutputBytes: maxOutput, killGrace: grace, environment: env)
    }
}

private func text(_ o: EngineOutput) -> String { String(decoding: o.stdout, as: UTF8.self) }

@Suite(.serialized) struct EngineRunnerTests {
    @Test func runsNodeWithExactlyTheExpectedArgv() async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$@""#)
        let out = try await e.runner().run(.scan)
        // The app's scan never reads project files; only the SessionStart hook does (SECURITY.md "What wasitme reads").
        #expect(text(out) == "\(e.cli.path)\nscan\n--no-project-files\n--json\n")
        #expect(out.action == .scan)
        #expect(text(try await e.runner().run(.report)) == "\(e.cli.path)\nreport\n--json\n")
    }

    // MARK: the scan's Node sandbox (engine.json scanArgs / scanCli; PRIVACY.md "The sandbox")

    /// The installer's shape: the permission flag, read grants, and write grants on wasitme's own folder only.
    private func sandboxExtra(_ e: FakeEngine, scanCli: URL? = nil, flag: String = "--permission") -> (String, [String]) {
        let args = [flag, "--allow-fs-read=/Users/someone/.claude*", "--allow-fs-read=/Users/someone/.codex*",
                    "--allow-fs-read=\(e.home.url.path)", "--allow-fs-write=\(e.home.url.path)",
                    "--allow-fs-write=\(EngineConfigLoader.realPath(e.home.url.path))"]
        let json = args.map { "\"\($0)\"" }.joined(separator: ",")
        return (#","scanArgs":[\#(json)],"scanCli":"\#((scanCli ?? e.cli).path)""#, args)
    }

    @Test func scanNowRunsUnderTheInstallersSandbox() async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$@""#)
        let scanCli = try e.home.write("scan-cli.js", "// the CLI through the resolved ~/.wasitme\n")
        let (extra, args) = sandboxExtra(e, scanCli: scanCli)
        try e.writeConfig(extra: extra)
        let config = try EngineConfigLoader.load(from: e.directory)
        #expect(config.scanIsSandboxed && config.scanArgs == args && config.scanCli?.path == scanCli.path)
        let want = args + [scanCli.path, "scan", "--no-project-files", "--json"]
        #expect(text(try await e.runner().run(.scan)) == want.joined(separator: "\n") + "\n")
        // the sandbox is the scan's: every other action keeps the plain form
        #expect(text(try await e.runner().run(.report)) == "\(e.cli.path)\nreport\n--json\n")
        #expect(text(try await e.runner().run(.doctor)) == "\(e.cli.path)\ndoctor\n--json\n")
    }

    @Test func theOlderPermissionFlagSpellingIsAccepted() async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$1""#)
        try e.writeConfig(extra: sandboxExtra(e, flag: "--experimental-permission").0)
        #expect(text(try await e.runner().run(.scan)) == "--experimental-permission\n")
    }

    @Test func anEmptyOrAbsentScanArgsMeansThisNodeHasNoSandbox() async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$@""#)
        try e.writeConfig(extra: #","scanArgs":[],"scanCli":"\#(e.cli.path)""#)
        #expect(text(try await e.runner().run(.scan)) == "\(e.cli.path)\nscan\n--no-project-files\n--json\n")
        #expect(try EngineConfigLoader.load(from: e.directory).scanIsSandboxed == false)
        try e.writeConfig()      // an engine.json from before the sandbox fields
        #expect(text(try await e.runner().run(.scan)) == "\(e.cli.path)\nscan\n--no-project-files\n--json\n")
    }

    /// Anything that is not exactly "one permission flag + absolute file-system grants" makes engine.json unusable:
    /// never a silently unsandboxed scan, and never a flag that widens the sandbox. No process starts.
    @Test(arguments: [
        #","scanArgs":"--permission""#,                                   // not a list
        #","scanArgs":null"#,
        #","scanArgs":["--permission",5]"#,
        #","scanArgs":["--allow-fs-read=/x"]"#,                           // grants without the permission flag
        #","scanArgs":["--permission","--permission","--allow-fs-read=/x"]"#,
        #","scanArgs":["--permission","--allow-child-process"]"#,         // widening flags are not grants
        #","scanArgs":["--permission","--allow-worker"]"#,
        #","scanArgs":["--permission","--allow-addons"]"#,
        #","scanArgs":["--permission","--allow-wasi"]"#,
        #","scanArgs":["--permission","--allow-net"]"#,
        #","scanArgs":["--permission","--inspect"]"#,
        #","scanArgs":["--permission","--allow-fs-read=relative/path"]"#,
        #","scanArgs":["--permission","--allow-fs-read=/a,/"]"#,          // one grant, one path
        #","scanArgs":["--permission","--allow-fs-read=/a\nb"]"#,
        #","scanArgs":["--permission","--allow-fs-write=/tmp"]"#,         // writes outside wasitme's folder
        #","scanArgs":["--permission","--allow-fs-write=/"]"#,
        #","scanArgs":["--permission"],"scanCli":5"#,
        #","scanArgs":["--permission"],"scanCli":"scan-cli.js""#,
        #","scanArgs":["--permission"],"scanCli":"/nonexistent/main.js""#,
    ])
    func malformedSandboxConfigsAreRefusedBeforeAnyProcessStarts(_ extra: String) async throws {
        let e = try FakeEngine(nodeBody: "touch '@MARKER@'")
        try e.writeConfig(extra: extra)
        do { _ = try await e.runner().run(.scan); Issue.record("expected a refusal for \(extra)") }
        catch let error as EngineError { guard case .invalidConfig = error else { Issue.record("got \(error)"); return } }
        #expect(!FileManager.default.fileExists(atPath: e.marker.path))
    }

    @Test func aScanArgumentIsNeverDuplicated() async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$@""#)
        let out = try await e.runner().run(.scan, arguments: ["--no-project-files"])
        #expect(text(out) == "\(e.cli.path)\nscan\n--no-project-files\n--json\n")
    }

    @Test(arguments: EngineAction.allCases)
    func everyAllowListedActionRuns(_ action: EngineAction) async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$2""#)
        #expect(text(try await e.runner().run(action)) == "\(action.rawValue)\n")
    }

    @Test func extraArgumentsComeBetweenTheActionAndJsonFlag() async throws {
        let e = try FakeEngine(nodeBody: #"printf '%s\n' "$@""#)
        let out = try await e.runner().run(.compare, arguments: ["--from", "2026-01-01", "--agent=claude-code"])
        #expect(text(out) == "\(e.cli.path)\ncompare\n--from\n2026-01-01\n--agent=claude-code\n--json\n")
    }

    @Test func theActionListIsExactlyTheFiveAllowedCommands() {
        #expect(Set(EngineAction.allCases.map(\.rawValue)) == ["scan", "report", "compare", "statusline", "doctor"])
        #expect(EngineAction(rawValue: "update") == nil)
        #expect(EngineAction(rawValue: "rm") == nil)
        #expect(EngineAction(rawValue: "SCAN") == nil)
    }

    // MARK: history clear (the Settings page's Clear History, after a native confirmation)

    /// A fixed argv, `WASITME_HOME` set to the runner's own folder, and the `wasitme.history-clear/1` answer read back.
    @Test func clearHistoryRunsExactlyTheFixedCommand() async throws {
        let e = try FakeEngine(nodeBody: #"""
        printf '%s\n' "$@" "WASITME_HOME=$WASITME_HOME" > '@MARKER@'
        printf '{\n  "schema": "wasitme.history-clear/1",\n  "cleared": true,\n  "files": 3,\n  "bytes": 2048\n}\n'
        """#)
        let r = try await e.runner().clearHistory()
        #expect(r == HistoryClearResult(cleared: true, files: 3, bytes: 2048))
        let lines = try String(contentsOf: e.marker, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(lines == [e.cli.path, "history", "clear", "--yes", "--json", "WASITME_HOME=\(e.directory.url.path)"])
    }

    /// Exit 1 (a scan held the lock; nothing deleted) and an answer that is not the document are errors, never success.
    @Test func clearHistoryFailuresAreErrors() async throws {
        let busy = try FakeEngine(nodeBody: "echo 'error: a scan is running right now' >&2; exit 1")
        await #expect(throws: EngineError.nonZeroExit(code: 1, stderr: "error: a scan is running right now")) {
            try await busy.runner().clearHistory()
        }
        let odd = try FakeEngine(nodeBody: "echo '{\"schema\":\"wasitme.other/1\",\"cleared\":true}'")
        await #expect(throws: EngineError.self) { try await odd.runner().clearHistory() }
        let none = try FakeEngine(nodeBody: "echo '{\"schema\":\"wasitme.history-clear/1\",\"cleared\":false,\"files\":0,\"bytes\":0}'")
        #expect(try await none.runner().clearHistory() == HistoryClearResult(cleared: false, files: 0, bytes: 0))
    }

    /// The raw-string entry point (a URL scheme, a menu item) can never reach history clear: it is no `EngineAction`.
    @Test func historyIsNotReachableFromTheRawEntryPoint() async throws {
        let e = try FakeEngine(nodeBody: "touch '@MARKER@'")
        await #expect(throws: EngineError.self) { try await e.runner().run(action: "history", arguments: ["clear", "--yes"]) }
        #expect(!FileManager.default.fileExists(atPath: e.marker.path))
    }

    @Test(arguments: ["rm", "update", "scan; rm -rf /", "$(touch pwned)", "scan --json", "", " scan", "../scan", "SCAN"])
    func actionsOutsideTheAllowListNeverStartAProcess(_ raw: String) async throws {
        let e = try FakeEngine(nodeBody: "touch '@MARKER@'")
        await #expect(throws: EngineError.self) { try await e.runner().run(action: raw) }
        #expect(!FileManager.default.fileExists(atPath: e.marker.path))
    }

    @Test(arguments: [
        ["; rm -rf /"], ["$(id)"], ["`id`"], ["a b"], ["a\nb"], ["--json"], [""], ["|cat"], ["a>b"], ["\"quoted\""],
        ["é"], [String(repeating: "a", count: 257)], Array(repeating: "x", count: 17),
    ])
    func unsafeArgumentsAreRefused(_ args: [String]) async throws {
        let e = try FakeEngine(nodeBody: "touch '@MARKER@'")
        await #expect(throws: EngineError.self) { try await e.runner().run(.report, arguments: args) }
        #expect(!FileManager.default.fileExists(atPath: e.marker.path))
    }

    @Test func notConfiguredWhenEngineJsonIsAbsent() async throws {
        let home = try TempDir("engine-none")
        let runner = EngineRunner(directory: WasitmeDirectory(home.url))
        await #expect(throws: EngineError.notConfigured) { try await runner.run(.doctor) }
    }

    @Test func nonZeroExitCarriesTheStderrTail() async throws {
        let e = try FakeEngine(nodeBody: "echo engine exploded 1>&2; exit 7")
        await #expect(throws: EngineError.nonZeroExit(code: 7, stderr: "engine exploded")) {
            try await e.runner().run(.scan)
        }
    }

    @Test func aSignalledEngineIsReportedAsKilled() async throws {
        let e = try FakeEngine(nodeBody: "kill -9 $$")
        await #expect(throws: EngineError.killedBySignal(9, stderr: "")) { try await e.runner().run(.scan) }
    }

    @Test func timeoutKillsTheEngineAndItsChildren() async throws {
        let e = try FakeEngine(nodeBody: "sleep 60 & echo $! > '@MARKER@'; wait")
        let start = Monotonic.now()
        await #expect(throws: EngineError.timedOut(seconds: 1)) {
            try await e.runner(timeout: 0.5, grace: 0.5).run(.scan)
        }
        #expect(Monotonic.seconds(from: start) < 8)
        let pid = try #require(e.markerPID)
        #expect(await waitUntil(timeout: 3) { kill(pid, 0) != 0 }, "engine's child survived the timeout")
    }

    @Test func outputIsBounded() async throws {
        let e = try FakeEngine(nodeBody: "head -c 5000 /dev/zero")
        await #expect(throws: EngineError.outputTooLarge(limitBytes: 1000)) {
            try await e.runner(maxOutput: 1000).run(.scan)
        }
    }

    @Test func defaultsMatchTheContract() async {
        let r = EngineRunner(directory: WasitmeDirectory(URL(fileURLWithPath: "/nonexistent")))
        #expect(r.timeout == 60)
        #expect(r.maxOutputBytes == 8 * 1024 * 1024)
    }

    @Test func environmentIsBuiltFromNothing() async throws {
        let e = try FakeEngine(nodeBody: "env")
        let env = [
            "HOME": "/home/test", "CODEX_HOME": "/codex", "CLAUDE_CONFIG_DIR": "/claude", "LANG": "en_US.UTF-8",
            "ANTHROPIC_API_KEY": "sk-secret", "OPENAI_API_KEY": "sk-other", "GITHUB_TOKEN": "ghp_x", "PATH": "/should/not/leak",
        ]
        let out = text(try await e.runner(env: env).run(.doctor))
        let lines = Set(out.split(separator: "\n").map(String.init))
        #expect(lines.contains("HOME=/home/test"))
        #expect(lines.contains("CODEX_HOME=/codex"))
        #expect(lines.contains("CLAUDE_CONFIG_DIR=/claude"))
        #expect(lines.contains("NO_COLOR=1"))
        #expect(lines.contains("PATH=\(e.home.url.path):/usr/bin:/bin"), "PATH must be node's dir plus system dirs only")
        #expect(!out.contains("sk-secret") && !out.contains("sk-other") && !out.contains("ghp_x"))
        #expect(!out.contains("/should/not/leak"))
    }

    @Test func environmentBuilderIsPure() {
        let node = URL(fileURLWithPath: "/opt/node/bin/node")
        let env = EngineEnvironment.make(base: ["HOME": "/h", "SECRET": "x", "TZ": "", "LANG": "C"], node: node)
        #expect(env["HOME"] == "/h" && env["LANG"] == "C")
        #expect(env["SECRET"] == nil)
        #expect(env["TZ"] == nil, "empty values are not forwarded")
        #expect(env["PATH"] == "/opt/node/bin:/usr/bin:/bin")
    }

    // MARK: a custom agent folder reaches the engine even when the app was not started by its LaunchAgent

    private let nodeURL = URL(fileURLWithPath: "/opt/node/bin/node")

    @Test func aFolderInTheAppsOwnEnvironmentWinsOverTheOneEngineJsonRecords() {
        let env = EngineEnvironment.make(base: ["HOME": "/h", "CLAUDE_CONFIG_DIR": "/env/claude", "CODEX_HOME": "/env/codex"],
                                         node: nodeURL, claudeDir: "/cfg/claude", codexDir: "/cfg/codex")
        #expect(env["CLAUDE_CONFIG_DIR"] == "/env/claude" && env["CODEX_HOME"] == "/env/codex")
    }

    @Test func withoutTheVariablesTheFoldersEngineJsonRecordsStandIn() {
        let env = EngineEnvironment.make(base: ["HOME": "/h"], node: nodeURL, claudeDir: "/cfg/claude", codexDir: "/cfg/codex")
        #expect(env["CLAUDE_CONFIG_DIR"] == "/cfg/claude" && env["CODEX_HOME"] == "/cfg/codex")
    }

    @Test func eachVariableFallsBackOnItsOwn() {
        let onlyClaude = EngineEnvironment.make(base: ["HOME": "/h", "CLAUDE_CONFIG_DIR": "/env/claude"], node: nodeURL,
                                                claudeDir: "/cfg/claude", codexDir: "/cfg/codex")
        #expect(onlyClaude["CLAUDE_CONFIG_DIR"] == "/env/claude" && onlyClaude["CODEX_HOME"] == "/cfg/codex")
        let onlyCodex = EngineEnvironment.make(base: ["HOME": "/h", "CODEX_HOME": "/env/codex"], node: nodeURL,
                                               claudeDir: "/cfg/claude", codexDir: "/cfg/codex")
        #expect(onlyCodex["CLAUDE_CONFIG_DIR"] == "/cfg/claude" && onlyCodex["CODEX_HOME"] == "/env/codex")
    }

    @Test(arguments: ["", " ", "\t\n"])
    func anEmptyOrBlankVariableCountsAsAbsent(_ blank: String) {
        let env = EngineEnvironment.make(base: ["HOME": "/h", "CLAUDE_CONFIG_DIR": blank, "CODEX_HOME": blank], node: nodeURL,
                                         claudeDir: "/cfg/claude", codexDir: "/cfg/codex")
        #expect(env["CLAUDE_CONFIG_DIR"] == "/cfg/claude" && env["CODEX_HOME"] == "/cfg/codex")
    }

    /// The installer sets the variables only for a non-default folder (scripts/lib/macos.sh). Setting CLAUDE_CONFIG_DIR to
    /// the default would move where the engine looks for Claude Code's global state file, so the default is never passed on.
    @Test(arguments: ["/h", "/h/"])
    func theDefaultFoldersAreNotPassedOn(_ home: String) {
        let env = EngineEnvironment.make(base: ["HOME": home], node: nodeURL, claudeDir: "/h/.claude", codexDir: "/h/.codex")
        #expect(env["CLAUDE_CONFIG_DIR"] == nil && env["CODEX_HOME"] == nil)
        // a folder merely under the default, or the default of another home, is custom
        let other = EngineEnvironment.make(base: ["HOME": home], node: nodeURL, claudeDir: "/h/.claude/work", codexDir: "/other/.codex")
        #expect(other["CLAUDE_CONFIG_DIR"] == "/h/.claude/work" && other["CODEX_HOME"] == "/other/.codex")
    }

    @Test func nothingRecordedAndNothingInTheEnvironmentLeavesBothUnset() {
        let env = EngineEnvironment.make(base: ["HOME": "/h"], node: nodeURL)
        #expect(env["CLAUDE_CONFIG_DIR"] == nil && env["CODEX_HOME"] == nil)
    }

    /// The env lines a fake engine prints when the app's own environment is `env` and engine.json carries `extra`.
    private func engineEnvironment(extra: String, env: [String: String]) async throws -> Set<String> {
        let e = try FakeEngine(nodeBody: "env")
        try e.writeConfig(extra: extra)
        let out = text(try await e.runner(env: env).run(.doctor))
        return Set(out.split(separator: "\n").map(String.init))
    }

    private let recordedFolders = #","claudeDir":"/cfg/claude","codexDir":"/cfg/codex""#

    @Test func theEngineSeesTheRecordedFoldersWhenTheAppHasNoVariables() async throws {
        let lines = try await engineEnvironment(extra: recordedFolders, env: ["HOME": "/home/test"])
        #expect(lines.contains("CLAUDE_CONFIG_DIR=/cfg/claude") && lines.contains("CODEX_HOME=/cfg/codex"))
    }

    @Test func theEngineSeesTheAppsOwnVariablesWhenItHasThem() async throws {
        let lines = try await engineEnvironment(extra: recordedFolders, env: ["HOME": "/home/test", "CLAUDE_CONFIG_DIR": "/env/claude", "CODEX_HOME": "/env/codex"])
        #expect(lines.contains("CLAUDE_CONFIG_DIR=/env/claude") && lines.contains("CODEX_HOME=/env/codex"))
        #expect(!lines.contains("CLAUDE_CONFIG_DIR=/cfg/claude") && !lines.contains("CODEX_HOME=/cfg/codex"))
    }

    @Test func anOlderEngineJsonWithoutTheFoldersChangesNothing() async throws {
        let lines = try await engineEnvironment(extra: "", env: ["HOME": "/home/test"])
        #expect(!lines.contains { $0.hasPrefix("CLAUDE_CONFIG_DIR=") || $0.hasPrefix("CODEX_HOME=") })
    }

    /// A recorded folder that is not a valid absolute path is ignored like an absent one: the run still happens, the engine
    /// just gets no variable for it, and the rest of engine.json is used as before.
    @Test(arguments: [
        #","claudeDir":"relative/dir","codexDir":"relative/dir""#,
        #","claudeDir":"~/claude","codexDir":"~/codex""#,                     // ~ is never expanded
        #","claudeDir":"","codexDir":"""#,
        #","claudeDir":"/a\nb","codexDir":"/a\u0000b""#,                       // control characters
        #","claudeDir":"/a\tb","codexDir":"/a\u007Fb\u001Bc""#,
        #","claudeDir":5,"codexDir":true"#,                                    // not strings
        #","claudeDir":null,"codexDir":null"#,
        #","claudeDir":["/cfg/claude"],"codexDir":{"path":"/cfg/codex"}"#,
        #","claudeDir":"/\#(String(repeating: "a", count: 4100))","codexDir":"/\#(String(repeating: "b", count: 5000))""#,
    ])
    func aMalformedRecordedFolderIsIgnored(_ extra: String) async throws {
        let e = try FakeEngine(nodeBody: "env")
        try e.writeConfig(extra: extra)
        let config = try EngineConfigLoader.load(from: e.directory)
        #expect(config.claudeDir == nil && config.codexDir == nil, "kept an invalid folder for \(extra.prefix(60))")
        #expect(config.node.path == e.node.path && config.cli.path == e.cli.path)
        let out = text(try await e.runner(env: ["HOME": "/home/test"]).run(.doctor))
        #expect(!out.contains("CLAUDE_CONFIG_DIR=") && !out.contains("CODEX_HOME="))
    }

    @Test func oneBadRecordedFolderDoesNotCostTheOther() async throws {
        let lines = try await engineEnvironment(extra: #","claudeDir":"relative","codexDir":"/cfg/codex""#, env: ["HOME": "/home/test"])
        #expect(!lines.contains { $0.hasPrefix("CLAUDE_CONFIG_DIR=") })
        #expect(lines.contains("CODEX_HOME=/cfg/codex"))
    }

    /// Scan now: the folder the engine is told to read is the folder the installer's read grants cover, because both come
    /// from the same engine.json (the installer writes them in one step, from the same variables).
    @Test func scanNowReadsTheSameFoldersTheSandboxGrantsRead() async throws {
        let e = try FakeEngine(nodeBody: #"env; printf 'ARG %s\n' "$@""#)
        let grants = ["--allow-fs-read=/cfg/claude*", "--allow-fs-read=/cfg/codex*",
                      "--allow-fs-read=\(e.home.url.path)", "--allow-fs-write=\(e.home.url.path)",
                      "--allow-fs-write=\(EngineConfigLoader.realPath(e.home.url.path))"]
        let args = ["--permission"] + grants
        try e.writeConfig(extra: #","scanArgs":[\#(args.map { "\"\($0)\"" }.joined(separator: ","))],"scanCli":"\#(e.cli.path)""# + recordedFolders)
        let config = try EngineConfigLoader.load(from: e.directory)
        let claude = try #require(config.claudeDir), codex = try #require(config.codexDir)
        #expect(config.scanArgs.contains("--allow-fs-read=\(claude)*") && config.scanArgs.contains("--allow-fs-read=\(codex)*"))
        let out = text(try await e.runner(env: ["HOME": "/home/test"]).run(.scan))
        let lines = Set(out.split(separator: "\n").map(String.init))
        #expect(lines.contains("CLAUDE_CONFIG_DIR=\(claude)") && lines.contains("CODEX_HOME=\(codex)"))
        #expect(lines.contains("ARG --allow-fs-read=\(claude)*") && lines.contains("ARG --allow-fs-read=\(codex)*"))
    }

    @Test func identicalInFlightRequestsShareOneProcess() async throws {
        let e = try FakeEngine(nodeBody: "echo x >> '@MARKER@'; sleep 0.6; echo done")
        let runner = e.runner()
        async let a = runner.run(.scan)
        async let b = runner.run(.scan)
        async let c = runner.run(.scan)
        let results = try await [a, b, c]
        #expect(results.allSatisfy { text($0) == "done\n" })
        #expect(e.markerLineCount == 1, "five refresh clicks must not start five scans")
        #expect(await runner.runsInFlight == 0)
    }

    @Test func differentRequestsAreNotCoalesced() async throws {
        let e = try FakeEngine(nodeBody: "echo x >> '@MARKER@'; sleep 0.3")
        let runner = e.runner()
        async let a = runner.run(.scan)
        async let b = runner.run(.report)
        _ = try await (a, b)
        #expect(e.markerLineCount == 2)
    }

    @Test func cancelAllKillsRunsInProgress() async throws {
        let e = try FakeEngine(nodeBody: "sleep 60")
        let runner = e.runner(timeout: 60)
        let task = Task { try await runner.run(.scan) }
        try await Task.sleep(for: .milliseconds(400))
        await runner.cancelAll()
        await #expect(throws: EngineError.cancelled) { try await task.value }
    }

    @Test func engineJsonIsReadFreshOnEveryRun() async throws {
        let e = try FakeEngine(nodeBody: "echo v1")
        let runner = e.runner()
        #expect(text(try await runner.run(.scan)) == "v1\n")
        try e.home.write("fake-node", "#!/bin/sh\necho v2\n", executable: true)
        #expect(text(try await runner.run(.scan)) == "v2\n")
    }

    @Test func aMissingNodeBinaryIsAConfigErrorNotACrash() async throws {
        let e = try FakeEngine(nodeBody: "echo hi")
        try e.writeConfig(node: "/nonexistent/node")
        do { _ = try await e.runner().run(.scan); Issue.record("expected failure") }
        catch let error as EngineError { guard case .invalidConfig = error else { Issue.record("got \(error)"); return } }
    }

    // MARK: against a real node, when this machine has one

    @Test(.enabled(if: RealNode.url != nil, "node is not installed here"))
    func realNodeRoundTrip() async throws {
        let node = try #require(RealNode.url)
        let home = try TempDir("engine-real")
        try home.write("cli.js", """
        const out = { argv: process.argv.slice(2), path: process.env.PATH, secret: process.env.WASITME_TEST_SECRET ?? null };
        process.stdout.write(JSON.stringify(out) + '\\n');
        """)
        try home.write("engine.json", #"{"node":"\#(node.path)","cli":"\#(home.file("cli.js").path)"}"#)
        let runner = EngineRunner(directory: WasitmeDirectory(home.url),
                                  environment: ["HOME": "/h", "WASITME_TEST_SECRET": "leaked"])
        let out = try await runner.run(.statusline)
        let obj = try #require(try JSONSerialization.jsonObject(with: out.stdout) as? [String: Any])
        #expect(obj["argv"] as? [String] == ["statusline", "--json"])
        #expect((obj["path"] as? String)?.hasSuffix(":/usr/bin:/bin") == true)
        #expect(obj["secret"] is NSNull, "the app's environment must not reach the engine")
    }

    /// Evidence, not argv: with the installer's flags, a real node really runs the scan sandboxed: it can read and write
    /// wasitme's folder and nothing else (the permission flag's spelling is probed exactly as the installer does).
    @Test(.enabled(if: RealNode.permissionFlag != nil, "this node has no permission model"))
    func realNodeRunsTheScanSandboxed() async throws {
        let node = try #require(RealNode.url), flag = try #require(RealNode.permissionFlag)
        let home = try TempDir("engine-sandbox")
        let own = EngineConfigLoader.realPath(home.url.path)        // node checks the resolved path (/var -> /private/var)
        try home.write("cli.js", """
        const fs = require('node:fs');
        let wrote = false, readEtc = false;
        try { fs.writeFileSync(require('node:path').join(\(String(reflecting: own)), 'probe.txt'), 'x'); wrote = true; } catch {}
        try { fs.readFileSync('/etc/hosts'); readEtc = true; } catch {}
        const p = process.permission;
        process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), sandboxed: !!p, wrote, readEtc,
          writeTmp: p ? p.has('fs.write', '/tmp') : true, childProcess: p ? p.has('child') : true }) + '\\n');
        """)
        let cli = own + "/cli.js"
        let args = [flag, "--allow-fs-read=\(own)", "--allow-fs-write=\(own)"]
        try home.write("engine.json", #"{"node":"\#(node.path)","cli":"\#(cli)","scanArgs":[\#(args.map { "\"\($0)\"" }.joined(separator: ","))],"scanCli":"\#(cli)"}"#)
        let out = try await EngineRunner(directory: WasitmeDirectory(home.url), environment: ["HOME": "/h"]).run(.scan)
        let obj = try #require(try JSONSerialization.jsonObject(with: out.stdout) as? [String: Any])
        #expect(obj["argv"] as? [String] == ["scan", "--no-project-files", "--json"])
        #expect(obj["sandboxed"] as? Bool == true, "the scan must run under node's permission model")
        #expect(obj["wrote"] as? Bool == true, "it may write wasitme's folder")
        #expect(obj["readEtc"] as? Bool == false, "it may read nothing outside its grants")
        #expect(obj["writeTmp"] as? Bool == false && obj["childProcess"] as? Bool == false)
    }
}

@Suite struct EngineConfigTests {
    private func parse(_ json: String) throws -> EngineConfig { try EngineConfigLoader.parse(Data(json.utf8)) }

    @Test func parsesAValidConfig() throws {
        let e = try FakeEngine(nodeBody: "true")
        let c = try EngineConfigLoader.load(from: e.directory)
        #expect(c.node.path == e.node.path && c.cli.path == e.cli.path && c.version == "0.0.0-test")
    }

    @Test func schemaAndVersionAreOptional() throws {
        let e = try FakeEngine(nodeBody: "true")
        _ = try parse(#"{"node":"\#(e.node.path)","cli":"\#(e.cli.path)"}"#)
    }

    @Test func unknownFieldsAreIgnored() throws {
        let e = try FakeEngine(nodeBody: "true")
        _ = try parse(#"{"node":"\#(e.node.path)","cli":"\#(e.cli.path)","future":{"x":1}}"#)
    }

    @Test func recordedAgentFoldersAreReadWhenValidAndAbsentOtherwise() throws {
        let e = try FakeEngine(nodeBody: "true")
        let head = #"{"node":"\#(e.node.path)","cli":"\#(e.cli.path)""#
        let both = try parse(head + #","claudeDir":"/cfg/claude","codexDir":"/cfg/codex"}"#)
        #expect(both.claudeDir == "/cfg/claude" && both.codexDir == "/cfg/codex")
        let older = try parse(head + "}")                        // an engine.json from before these fields
        #expect(older.claudeDir == nil && older.codexDir == nil)
        let oneBad = try parse(head + #","claudeDir":"relative","codexDir":"/cfg/codex"}"#)
        #expect(oneBad.claudeDir == nil && oneBad.codexDir == "/cfg/codex")
    }

    @Test func aBadRecordedFolderNeverMakesTheRestOfEngineJsonUnusable() throws {
        let e = try FakeEngine(nodeBody: "true")
        let c = try parse(#"{"node":"\#(e.node.path)","cli":"\#(e.cli.path)","version":"1.2.3","claudeDir":"x\ny","codexDir":7}"#)
        #expect(c.claudeDir == nil && c.codexDir == nil)
        #expect(c.version == "1.2.3" && c.node.path == e.node.path)
    }

    @Test(arguments: [
        "", "not json", "[]", "{}", #"{"node":"/bin/sh"}"#, #"{"cli":"/bin/sh"}"#,
        #"{"node":"node","cli":"/bin/sh"}"#,                  // relative: never searched on PATH
        #"{"node":"~/bin/node","cli":"/bin/sh"}"#,            // ~ is not expanded
        #"{"node":"/bin/sh","cli":"cli.js"}"#,
        #"{"node":"/nonexistent/node","cli":"/bin/sh"}"#,
        #"{"node":"/bin/sh","cli":"/nonexistent/cli.js"}"#,
        #"{"node":"/usr/bin","cli":"/bin/sh"}"#,              // a directory is not a program
        #"{"node":"/bin/sh","cli":"/usr/bin"}"#,
        #"{"node":"/etc/hosts","cli":"/bin/sh"}"#,            // exists but not executable
        #"{"schema":"wasitme.engine/2","node":"/bin/sh","cli":"/bin/sh"}"#,
        #"{"schema":"wasitme.glance/1","node":"/bin/sh","cli":"/bin/sh"}"#,
        #"{"schema":"junk","node":"/bin/sh","cli":"/bin/sh"}"#,
        #"{"node":"/bin/sh\u0000x","cli":"/bin/sh"}"#,
        #"{"node":"/bin/sh","cli":"/bin/sh\n"}"#,
        #"{"node":5,"cli":"/bin/sh"}"#,
    ])
    func rejectsUnusableConfigs(_ json: String) {
        #expect(throws: EngineError.self) { try parse(json) }
    }

    @Test func oversizedConfigIsRefusedWithoutReadingIt() throws {
        let home = try TempDir("engine-big")
        try home.write("engine.json", String(repeating: " ", count: 70_000) + "{}")
        #expect(throws: EngineError.invalidConfig("file is unreasonably large")) {
            try EngineConfigLoader.load(from: WasitmeDirectory(home.url))
        }
    }

    @Test func errorsReadAsPlainSentences() {
        #expect(EngineError.notConfigured.description.contains("not set up"))
        #expect(EngineError.timedOut(seconds: 60).description == "The engine did not finish within 60 s.")
    }
}

// MARK: - helpers

private enum RealNode {
    static let url: URL? = {
        let fm = FileManager.default
        var dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", NSHomeDirectory() + "/.local/bin"]
        for d in dirs {
            let p = d + "/node"
            if fm.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }()

    /// The permission flag this node accepts, feature-tested like the installer's perm_probe (the flag's name changed
    /// inside the Node 22 line, so a version check would be wrong); nil when it has none.
    static let permissionFlag: String? = {
        guard let node = url else { return nil }
        for flag in ["--permission", "--experimental-permission"] {
            let p = Process()
            p.executableURL = node
            p.arguments = [flag, "-e", "0"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            guard (try? p.run()) != nil else { return nil }
            p.waitUntilExit()
            if p.terminationStatus == 0 { return flag }
        }
        return nil
    }()
}
