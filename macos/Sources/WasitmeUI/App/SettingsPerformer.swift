import Foundation
import WasitmeCore

/// The Settings page's backend: knows what is installed (`install.sh --status --json`), says whether each change can run
/// now, and runs the ones the user confirmed (`GuardedConsent`) through the installer, the uninstaller or the engine.
///
/// Every run is a fixed argv (`SetupCommand`, `EngineRunner.clearHistory`), one at a time. Runs that can touch the app's
/// own LaunchAgent start detached (`--from-app`) and are followed through the action record; a run that removes the app
/// quits it once the run has started. Nothing here orders a window in: the sheets are the flow's, and quitting, scanning
/// and re-rendering are the closures it is given.
@MainActor
public final class SettingsPerformer: GuardedActionPerforming {
    public struct Timing: Sendable {
        public var poll: Duration
        /// How long to follow an add or a remove (Claude Code's plugin commands can be slow).
        public var partTimeout: TimeInterval
        /// How long to follow an update (it may rebuild the app from source).
        public var updateTimeout: TimeInterval
        public static let standard = Timing(poll: .seconds(1), partTimeout: 15 * 60, updateTimeout: 45 * 60)
        public init(poll: Duration, partTimeout: TimeInterval, updateTimeout: TimeInterval) {
            self.poll = poll; self.partTimeout = partTimeout; self.updateTimeout = updateTimeout
        }
    }

    /// nil: this copy's folder is not one its installer manages (`SetupLocation`), so only Clear History can run.
    let setup: SetupRunner?
    let clearHistory: @Sendable () async throws -> HistoryClearResult
    let engineConfigured: () -> Bool
    let quit: () -> Void
    let afterClear: () -> Void
    let isAlive: @Sendable (pid_t) -> Bool
    let now: () -> Date
    let defaults: UserDefaults
    let timing: Timing
    /// Called whenever what the page should show changed (a run started or ended, the status was read).
    public var onChange: () -> Void = {}

    /// The installer's last answer; nil until it has been asked.
    public private(set) var status: InstallStatus?
    /// The change this app is running now.
    public private(set) var running: GuardedAction?
    /// A run another copy of the app started that is still going (from the action record).
    public private(set) var otherRun: ActionRecord.Kind?
    public private(set) var canClearHistory = false
    private var lastRecord: ActionRecord?
    private var refreshing: Task<Void, Never>?

    static let reportedKey = "settings.reportedActionStart"

    public init(setup: SetupRunner?, clearHistory: @escaping @Sendable () async throws -> HistoryClearResult,
                engineConfigured: @escaping () -> Bool, quit: @escaping () -> Void, afterClear: @escaping () -> Void,
                isAlive: @escaping @Sendable (pid_t) -> Bool = ProcessLiveness.isAlive, now: @escaping () -> Date = Date.init,
                defaults: UserDefaults = .standard, timing: Timing = .standard) {
        self.setup = setup
        self.clearHistory = clearHistory
        self.engineConfigured = engineConfigured
        self.quit = quit
        self.afterClear = afterClear
        self.isAlive = isAlive
        self.now = now
        self.defaults = defaults
        self.timing = timing
    }

    /// The app's own: the installer of the folder the app reads, the engine runner it scans with.
    public static func make(directory: WasitmeDirectory, engine: EngineRunner, quit: @escaping () -> Void,
                            afterClear: @escaping () -> Void) -> SettingsPerformer {
        SettingsPerformer(
            setup: SetupLocation(directory: directory).map { SetupRunner(location: $0) },
            clearHistory: { try await engine.clearHistory() },
            engineConfigured: { (try? EngineConfigLoader.load(from: directory)) != nil },
            quit: quit, afterClear: afterClear)
    }

    // MARK: state

    /// Asks the installer again (and reads the action record). Calls made while one is under way share it.
    public func refresh() async {
        if let refreshing { return await refreshing.value }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            let status = await self.setup?.readStatus() ?? .unknown
            let record = self.setup?.readRecord()
            self.status = status
            self.lastRecord = record
            self.otherRun = (record?.isBusy(now: self.now(), isAlive: self.isAlive) == true && self.running == nil) ? record?.kind : nil
            self.canClearHistory = self.engineConfigured()
            self.onChange()
        }
        refreshing = task
        await task.value
        refreshing = nil
    }

    /// What `view.settings` carries now.
    public func state(desktopPanel: Bool, launchAtLogin: LaunchAtLoginState) -> SettingsState {
        SettingsState(status: status ?? .unknown, desktopPanel: desktopPanel, launchAtLogin: launchAtLogin,
                      canClearHistory: canClearHistory,
                      busy: running?.busyWord ?? otherRun.map(SettingsState.busyWord(for:)))
    }

    // MARK: GuardedActionPerforming

    public func availability(_ action: GuardedAction) -> GuardedAvailability {
        if running != nil || otherRun != nil {
            return .unavailable("Another change is still running. Try again when it has finished.")
        }
        if action == .clearHistory {
            return canClearHistory ? .available : .unavailable("wasitme's engine isn't set up, so there is no saved history to clear.")
        }
        guard setup != nil else {
            return .unavailable("This copy of wasitme reads a folder its installer doesn't manage.")
        }
        guard let status else { return .unavailable("wasitme is still reading what is installed. Try again in a moment.") }
        guard status.answered else { return .unavailable("wasitme couldn't read what is installed. Open Settings again to retry.") }
        guard status.installed else { return .unavailable("No install record; run the installer once.") }
        switch action {
        case .addIntegration(let id):
            guard id.canBeAddedFromInstalledCopy else { return .unavailable("Only the installer adds the menu bar app.") }
            let part = status.part(id)
            switch part.state {
            case .off: return .available
            case .on: return .unavailable("\(Self.sentence(id.title)) is already on.")
            default: return .unavailable(Self.reason(part))
            }
        case .removeIntegration(let id):
            let part = status.part(id)
            switch part.state {
            case .on: return .available
            case .off: return .unavailable("\(Self.sentence(id.title)) is already off.")
            default: return .unavailable(Self.reason(part))
            }
        case .uninstallAll:
            return .available
        case .updateApp, .updateAcceptingPluginChanges:
            if status.updateAvailable { return .available }
            return .unavailable(status.updateWhy == .noRelease ? "Updates arrive with the first public release."
                                                               : "No newer release can be checked for here.")
        case .clearHistory:
            return .available    // handled above
        }
    }

    public func perform(_ consent: GuardedConsent) async -> GuardedActionResult {
        let action = consent.action
        running = action
        otherRun = nil
        lastRecord = nil              // the record this run replaces is not "an update that ended" any more
        onChange()
        let result = await run(consent)
        running = nil
        if result != .quitting {
            onChange()
            await refresh()
        }
        return result
    }

    private func run(_ consent: GuardedConsent) async -> GuardedActionResult {
        let action = consent.action
        switch action {
        case .clearHistory:
            do {
                _ = try await clearHistory()
                afterClear()
                return .done
            } catch EngineError.nonZeroExit(1, _) {
                return .failed(Self.failTitle(action), detail: "A check was running, so nothing was deleted. Try again in a minute.")
            } catch {
                return .failed(Self.failTitle(action), detail: TextSanitizer.clean(String(describing: error), maxCharacters: 300))
            }
        case .uninstallAll:
            return await startThenQuit(.uninstallAll(purge: consent.option), action)
        case .removeIntegration(.app):
            return await startThenQuit(.remove(.app), action)
        case .removeIntegration(let id):
            return await startAndFollow(.remove(id), action, timeout: timing.partTimeout)
        case .addIntegration(let id):
            return await startAndFollow(.add(id), action, timeout: timing.partTimeout)
        case .updateApp:
            return await startAndFollow(.update(acceptPluginChanges: false), action, timeout: timing.updateTimeout)
        case .updateAcceptingPluginChanges:
            return await startAndFollow(.update(acceptPluginChanges: true), action, timeout: timing.updateTimeout)
        }
    }

    /// Removing the app: start the detached run, then quit (the uninstaller waits for the app to go before removing it).
    private func startThenQuit(_ command: SetupCommand, _ action: GuardedAction) async -> GuardedActionResult {
        guard let setup else { return .failed(Self.failTitle(action), detail: "Nothing was changed.") }
        switch await setup.start(command) {
        case .started:
            quit()
            return .quitting
        case .refused(let why):
            return .failed(Self.failTitle(action), detail: "\(Self.ended(why)) Nothing was changed.")
        case .unavailable:
            return .failed(Self.failTitle(action), detail: "This install has no uninstaller to run. Nothing was changed.")
        }
    }

    /// Start the detached run, then follow its record until it ends.
    private func startAndFollow(_ command: SetupCommand, _ action: GuardedAction, timeout: TimeInterval) async -> GuardedActionResult {
        guard let setup else { return .failed(Self.failTitle(action), detail: "Nothing was changed.") }
        switch await setup.start(command) {
        case .refused(let why):
            return .failed(Self.failTitle(action), detail: "\(Self.ended(why)) Nothing was changed.")
        case .unavailable:
            return .failed(Self.failTitle(action), detail: "This install has no installer to run. Nothing was changed.")
        case .started:
            break
        }
        let outcome = await setup.waitForOutcome(timeout: timeout, interval: timing.poll, isAlive: isAlive)
        markReported(setup.readRecord())
        return Self.result(of: outcome, for: action)
    }

    /// What the user sees once a run has ended (pure; tested).
    static func result(of outcome: ActionOutcome, for action: GuardedAction) -> GuardedActionResult {
        let isUpdate = action == .updateApp || action == .updateAcceptingPluginChanges
        switch cleaned(outcome) {
        case .done(let summary):
            return isUpdate ? .report("wasitme was updated", detail: summary.isEmpty ? nil : summary) : .done
        case .missing, .starting, .running:
            return .done
        case .partial(let summary):
            return .failed(failTitle(action), detail: [ended(summary), "That part was undone, and nothing else was changed."]
                .filter { !$0.isEmpty }.joined(separator: " "))
        case .stopped(let summary):
            if isUpdate && action != .updateAcceptingPluginChanges { return .confirmNext(.updateAcceptingPluginChanges, note: summary) }
            return .failed(failTitle(action), detail: summary.isEmpty ? "Nothing was changed." : "\(ended(summary)) Nothing was changed.")
        case .failed(let code, let summary):
            var detail = summary.isEmpty ? "It stopped with exit code \(code.map(String.init) ?? "unknown")." : ended(summary)
            // `--add` refuses before changing anything (exit 1); other failures may have changed part of it.
            if case .addIntegration = action, code == 1 { detail += " Nothing was changed." }
            return .failed(failTitle(action), detail: detail)
        case .cutShort:
            return .failed(failTitle(action), detail: "It stopped before it finished, perhaps because the Mac restarted. Settings shows what is installed now.")
        case .timedOut:
            return .report("Still working", detail: "This is taking longer than usual. Settings shows the result once it has finished.")
        }
    }

    // MARK: an update's result, after the app was quit and opened again

    /// The result of an update this app started and was quit by (the installer quits and reopens it), once: nil when
    /// there is none, or it was already shown. Only for a run that ended in the last day by the wall clock (a clock that
    /// went backward shows nothing).
    public func takeUnreportedUpdate() -> (text: String, detail: String?)? {
        guard let record = lastRecord, record.kind == .update, let started = record.started,
              defaults.string(forKey: Self.reportedKey) != started else { return nil }
        let outcome = record.outcome(isAlive: isAlive)
        guard outcome.isFinal else { return nil }
        let ended = record.finished.flatMap(ContractDate.parse) ?? ContractDate.parse(started)
        guard let ended, case let age = now().timeIntervalSince(ended), age >= 0, age < 86_400 else { return nil }
        defaults.set(started, forKey: Self.reportedKey)
        switch Self.result(of: outcome, for: .updateApp) {
        case .report(let text, let detail), .failed(let text, let detail): return (text, detail)
        case .confirmNext(_, let note):
            return ("The update stopped", "\(note) The new Claude Code plugin hooks or calls more than the one you have. Nothing was changed; click Update… to see what it adds.")
        case .done, .quitting: return nil
        }
    }

    private func markReported(_ record: ActionRecord?) {
        if let started = record?.started { defaults.set(started, forKey: Self.reportedKey) }
    }

    // MARK: words

    static func sentence(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// The run's last line as a sheet shows it: without the script's `error: ` / `warning: ` prefix, capitalised.
    nonisolated static func line(_ s: String) -> String {
        var t = s
        for prefix in ["error: ", "warning: "] where t.hasPrefix(prefix) { t.removeFirst(prefix.count) }
        return t.prefix(1).uppercased() + t.dropFirst()
    }

    static func cleaned(_ outcome: ActionOutcome) -> ActionOutcome {
        switch outcome {
        case .done(let s): .done(line(s))
        case .partial(let s): .partial(line(s))
        case .stopped(let s): .stopped(line(s))
        case .failed(let code, let s): .failed(code: code, line(s))
        default: outcome
        }
    }

    /// A script's line as a sentence: ends with a full stop unless it already ends a sentence.
    nonisolated static func ended(_ s: String) -> String {
        guard let last = s.last else { return s }
        return ".!?".contains(last) ? s : s + "."
    }

    static func failTitle(_ action: GuardedAction) -> String {
        switch action {
        case .addIntegration(let id): id == .scan ? "Couldn't turn on \(id.title)" : "Couldn't add \(id.title)"
        case .removeIntegration(let id): id == .scan ? "Couldn't turn off \(id.title)" : "Couldn't remove \(id.title)"
        case .clearHistory: "The history wasn't cleared"
        case .uninstallAll: "Couldn't uninstall wasitme"
        case .updateApp, .updateAcceptingPluginChanges: "Couldn't update wasitme"
        }
    }

    /// Why a part can't be added or removed, from the installer's code (never guessed).
    static func reason(_ part: InstallStatus.Part) -> String {
        switch (part.state, part.why) {
        case (.own, _): return "You have your own status line; wasitme leaves it alone."
        case (_, .agentMissing?):
            return part.id == .codexPlugin ? "Codex isn't installed." : "Claude Code isn't installed."
        case (_, .notSupported?): return "This Mac or this copy of wasitme can't add it."
        case (_, .noInstallRecord?): return "No install record; run the installer once."
        case (.unknown, _): return "wasitme couldn't read whether it is installed."
        default: return "It isn't available here."
        }
    }
}
