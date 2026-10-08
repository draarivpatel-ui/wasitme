import Darwin
import Foundation

/// How starting a detached run went. Only whether it started: the outcome is in the action record.
public enum SetupStart: Equatable, Sendable {
    case started
    /// Nothing started: another run is still going, the folder is not usable, or the script refused. The reason is the
    /// script's own last line, cleaned for display (a sheet only).
    case refused(String)
    /// This install has no command for it, or no installed copy of the scripts to run.
    case unavailable
}

/// Runs the installer and uninstaller of this install for the Settings page: `/bin/sh` by absolute path with an argv from
/// `SetupCommand` (never a shell string), an environment built from nothing (`EngineEnvironment`, so the scripts look at
/// the same agent folders as the engine), a timeout and bounded output (`ProcessRunner`). Reads `--status` and the action
/// record; never reads `~/.claude` or `~/.codex` itself.
public struct SetupRunner: Sendable {
    public typealias Run = @Sendable (ProcessSpec) async throws -> ProcessResult

    public let location: SetupLocation
    let baseEnvironment: [String: String]
    let run: Run
    /// `--status` reads files and asks node three questions; a detached start returns at once.
    let statusTimeout: TimeInterval
    let startTimeout: TimeInterval

    public init(location: SetupLocation, baseEnvironment: [String: String] = ProcessInfo.processInfo.environment,
                statusTimeout: TimeInterval = 60, startTimeout: TimeInterval = 30,
                run: @escaping Run = { try await ProcessRunner.run($0) }) {
        self.location = location
        self.baseEnvironment = baseEnvironment
        self.statusTimeout = statusTimeout
        self.startTimeout = startTimeout
        self.run = run
    }

    /// The child's whole environment: the engine's (HOME, the agent folders the install recorded, node's folder first on
    /// PATH, which `--from-app` needs to find node). Without a usable engine.json, the same minus node.
    func environment() -> [String: String] {
        let config = try? EngineConfigLoader.load(from: location.directory)
        return EngineEnvironment.make(base: baseEnvironment, node: config?.node,
                                      claudeDir: config?.claudeDir, codexDir: config?.codexDir)
    }

    /// The process for `command`, or nil when this install has no such command.
    public func spec(_ command: SetupCommand) -> ProcessSpec? {
        guard let argv = command.argv(in: location) else { return nil }
        return ProcessSpec(executable: SetupCommand.shell, arguments: argv, environment: environment(),
                           currentDirectory: URL(fileURLWithPath: "/"),
                           timeout: command.runsDetached ? startTimeout : statusTimeout,
                           maxOutputBytes: 256 * 1024, killGrace: 2)
    }

    /// `install.sh --status --json`. No installed copy of the scripts: `.notInstalled`. Anything else that goes wrong (a
    /// failed run, an exit other than 0, an answer that is not the status document): `.unknown`.
    public func readStatus() async -> InstallStatus {
        guard location.scriptsPresent else { return .notInstalled }
        guard let spec = spec(.status) else { return .unknown }
        guard let result = try? await run(spec), !result.terminatedBySignal, result.status == 0 else { return .unknown }
        return InstallStatus.parse(result.stdout)
    }

    /// Starts a detached run. Exit 0 means it started; 1 that nothing started (another run is going, or the folder is not
    /// usable); 2 a usage error. Status is not a detached command and is refused here.
    public func start(_ command: SetupCommand) async -> SetupStart {
        guard command.runsDetached, location.scriptsPresent, let spec = spec(command) else { return .unavailable }
        let result: ProcessResult
        do { result = try await run(spec) } catch { return .refused("It could not be started.") }
        if !result.terminatedBySignal && result.status == 0 { return .started }
        return .refused(Self.reason(result.stderr) ?? "It could not be started.")
    }

    /// The last line a script printed on stderr, without its `error: ` prefix, cleaned for a sheet.
    static func reason(_ stderr: Data) -> String? {
        let text = String(decoding: stderr.suffix(4096), as: UTF8.self)
        guard var line = text.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) })
            .last(where: { !$0.isEmpty }) else { return nil }
        if line.hasPrefix("error: ") { line.removeFirst("error: ".count) }
        let clean = TextSanitizer.clean(line, maxCharacters: 300)
        guard !clean.isEmpty else { return nil }
        return clean.prefix(1).uppercased() + clean.dropFirst()
    }

    public func readRecord() -> ActionRecord? { ActionRecord.read(location.actionRecord) }

    /// Polls the action record until the run is over or `timeout` passes (a monotonic clock: a wall-clock step changes
    /// nothing). A record still without a pid after `startGrace` was never picked up by its second stage: cut short.
    public func waitForOutcome(timeout: TimeInterval, interval: Duration = .seconds(1), startGrace: TimeInterval = 60,
                               isAlive: @escaping @Sendable (pid_t) -> Bool = ProcessLiveness.isAlive) async -> ActionOutcome {
        let start = Monotonic.now()
        var seenRecord = false
        while true {
            let elapsed = Monotonic.seconds(from: start)
            if let record = readRecord() {
                seenRecord = true
                let outcome = record.outcome(isAlive: isAlive)
                if outcome.isFinal { return outcome }
                if outcome == .starting && elapsed >= startGrace { return .cutShort }
            } else if seenRecord || elapsed >= 10 {
                // The run deleted its own record (a full uninstall does), or it never appeared.
                return .missing
            }
            if elapsed >= timeout || Task.isCancelled { return .timedOut }
            try? await Task.sleep(for: interval)
        }
    }
}
