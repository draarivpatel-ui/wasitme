import Foundation

public struct EngineOutput: Sendable, Equatable {
    public var action: EngineAction
    /// Exactly what the engine printed on stdout (expected to be JSON because of `--json`).
    public var stdout: Data
    public var stderr: Data
    public var duration: TimeInterval
}

/// Runs the engine CLI: `node <cli> <action> --json`, argv built explicitly, no shell, from an
/// allow-list of actions, with a timeout, bounded output, and tree-wide kill. A scan is
/// `node [scanArgs] <scanCli> scan --no-project-files --json`: the background scan's sandbox and grants (PRIVACY.md,
/// `EngineConfig.argv`).
///
/// Where `node` and the CLI live comes from `~/.wasitme/engine.json` (see `EngineConfig`), read fresh
/// on every run so an engine update that moves the files is picked up without restarting the app.
///
/// Identical in-flight requests (same action and arguments) are coalesced: pressing "Refresh" five
/// times starts one scan, and all five callers receive its result. Cancelling a caller does not stop a
/// run other callers may share; use `cancelAll()` for that. Every run is bounded: the engine's lifetime by
/// `timeout` (then `killGrace`), and reading its pipes after it has exited by a further second at most
/// (see `ProcessRunner`), even if a descendant keeps writing to them.
public actor EngineRunner {
    public nonisolated let directory: WasitmeDirectory
    public nonisolated let timeout: TimeInterval
    public nonisolated let maxOutputBytes: Int
    public nonisolated let killGrace: TimeInterval
    private let baseEnvironment: [String: String]
    private var inFlight: [String: Task<EngineOutput, Error>] = [:]

    public init(
        directory: WasitmeDirectory = .standard(),
        timeout: TimeInterval = 60,
        maxOutputBytes: Int = 8 * 1024 * 1024,
        killGrace: TimeInterval = 2,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.directory = directory
        self.timeout = timeout
        self.maxOutputBytes = maxOutputBytes
        self.killGrace = killGrace
        self.baseEnvironment = environment
    }

    /// For untrusted input (a URL scheme, a menu item's string): anything outside the five allowed
    /// actions is refused before any process is started.
    public func run(action rawAction: String, arguments: [String] = []) async throws -> EngineOutput {
        guard let action = EngineAction(rawValue: rawAction) else {
            throw EngineError.invalidArgument("\"\(rawAction.prefix(32))\" is not an allowed action")
        }
        return try await run(action, arguments: arguments)
    }

    public func run(_ action: EngineAction, arguments: [String] = []) async throws -> EngineOutput {
        try EngineArguments.validate(arguments)
        let key = ([action.rawValue] + arguments).joined(separator: "\u{0}")
        if let existing = inFlight[key] { return try await existing.value }
        let task = Task { try await self.execute(action, arguments: arguments) }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        return try await task.value
    }

    /// Cancels every run in progress (their process trees are killed).
    public func cancelAll() {
        for task in inFlight.values { task.cancel() }
    }

    public var runsInFlight: Int { inFlight.count }

    // MARK: -

    /// `wasitme history clear --yes --json`: the Settings page's Clear History, run only after the user confirmed it in a
    /// native sheet. A fixed argv (`[cli, "history", "clear", "--yes", "--json"]`), deliberately NOT one of the
    /// `EngineAction`s, so the raw-string entry point can never reach it. `WASITME_HOME` names this runner's own folder
    /// (set for every run, see `execute(argv:config:environment:)`), so exactly the history the app reads is the history cleared. Exit 1 (a scan held the lock; nothing was deleted)
    /// comes back as `EngineError.nonZeroExit(code: 1, ...)`.
    public func clearHistory() async throws -> HistoryClearResult {
        let config = try EngineConfigLoader.load(from: directory)
        let env = EngineEnvironment.make(base: baseEnvironment, node: config.node,
                                         claudeDir: config.claudeDir, codexDir: config.codexDir)
        let out = try await execute(argv: HistoryClearResult.argv(cli: config.cli), config: config, environment: env)
        guard let result = HistoryClearResult.parse(out) else {
            throw EngineError.invalidArgument("history clear did not answer with wasitme.history-clear/1")
        }
        return result
    }

    private func execute(_ action: EngineAction, arguments: [String]) async throws -> EngineOutput {
        let config = try EngineConfigLoader.load(from: directory)
        let out = try await execute(argv: config.argv(action, arguments: arguments), config: config,
                                    environment: EngineEnvironment.make(base: baseEnvironment, node: config.node,
                                                                        claudeDir: config.claudeDir, codexDir: config.codexDir))
        return EngineOutput(action: action, stdout: out.stdout, stderr: out.stderr, duration: out.duration)
    }

    private func execute(argv: [String], config: EngineConfig, environment: [String: String]) async throws -> ProcessResult {
        // Every run names the folder this runner (and the app's GlanceStore) reads, so the engine never falls back to
        // `$HOME/.wasitme` when the app was opened with `--home <dir>`: a sandbox instance's Check Again, Copy Report and
        // `--self-check` then scan, report and diagnose that folder, never the real one. For the default folder this is
        // the very path the engine would pick anyway. Set last, so an inherited value can never redirect a run.
        var environment = environment
        environment["WASITME_HOME"] = directory.url.path
        let spec = ProcessSpec(
            executable: config.node,
            arguments: argv,
            environment: environment,
            currentDirectory: workingDirectory(),
            timeout: timeout, maxOutputBytes: maxOutputBytes, killGrace: killGrace)

        let result: ProcessResult
        do {
            result = try await ProcessRunner.run(spec)
        } catch let failure as ProcessFailure {
            switch failure {
            case .launchFailed(let m): throw EngineError.launchFailed(m)
            case .timedOut(let t): throw EngineError.timedOut(seconds: Int(t.rounded(.up)))
            case .outputTooLarge(let n): throw EngineError.outputTooLarge(limitBytes: n)
            case .cancelled: throw EngineError.cancelled
            }
        }

        if result.terminatedBySignal { throw EngineError.killedBySignal(result.status, stderr: Self.tail(result.stderr)) }
        guard result.status == 0 else { throw EngineError.nonZeroExit(code: result.status, stderr: Self.tail(result.stderr)) }
        return result
    }

    /// The engine's own directory when it exists (so stray relative writes land there), else `/`.
    private func workingDirectory() -> URL {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.url.path, isDirectory: &isDir), isDir.boolValue {
            return directory.url
        }
        return URL(fileURLWithPath: "/")
    }

    /// Last ~2 KB of stderr as text, for error messages only (displayed locally, never stored).
    static func tail(_ data: Data) -> String {
        let slice = data.suffix(2048)
        return String(decoding: slice, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// What `wasitme history clear --yes --json` printed (`wasitme.history-clear/1`): counts only, never a path.
public struct HistoryClearResult: Equatable, Sendable {
    /// Something was deleted (false: there was no saved history).
    public let cleared: Bool
    public let files: Int
    public let bytes: Int

    static func argv(cli: URL) -> [String] { [cli.path, "history", "clear", "--yes", "--json"] }

    static func parse(_ result: ProcessResult) -> HistoryClearResult? {
        guard let object = try? JSONSerialization.jsonObject(with: result.stdout), let d = object as? [String: Any],
              d["schema"] as? String == "wasitme.history-clear/1",
              let cleared = (d["cleared"] as? NSNumber).flatMap(InstallStatus.strictBool) else { return nil }
        return HistoryClearResult(cleared: cleared, files: (d["files"] as? NSNumber)?.intValue ?? 0,
                                  bytes: (d["bytes"] as? NSNumber)?.intValue ?? 0)
    }
}
