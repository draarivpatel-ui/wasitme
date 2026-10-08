import Darwin
import Foundation

/// What `install.sh --status --json` says about this install (`wasitme.install-status/1`), read tolerantly: an unknown
/// state becomes `unknown`, an unknown `why` code is dropped, an unknown id is ignored, and a missing id is `unknown`.
/// Every value is a fixed code or the installed version; the app never reads `~/.claude`, `~/.codex` or their settings
/// itself, only this answer.
public struct InstallStatus: Equatable, Sendable {
    public enum State: String, Sendable, CaseIterable {
        case on, off
        /// The person's own status line, which wasitme leaves alone.
        case own
        case unavailable
        case unknown
    }

    public enum Why: String, Sendable, CaseIterable {
        case agentMissing = "agent_missing"
        case notSupported = "not_supported"
        case noInstallRecord = "no_install_record"
        case noRelease = "no_release"
    }

    public struct Part: Equatable, Sendable {
        public let id: IntegrationID
        public let state: State
        public let why: Why?
        public init(id: IntegrationID, state: State, why: Why? = nil) {
            self.id = id; self.state = state; self.why = why
        }
    }

    /// An install record exists.
    public let installed: Bool
    /// The installed version (`[A-Za-z0-9._+-]`, at most 64 characters), else nil.
    public let version: String?
    /// One entry per id, in `IntegrationID.displayOrder`.
    public let parts: [Part]
    public let updateAvailable: Bool
    public let updateWhy: Why?
    /// The installer answered. False: every value here is a stand-in (`unknown`), and nothing may be offered.
    public let answered: Bool

    public init(installed: Bool, version: String?, parts: [Part], updateAvailable: Bool, updateWhy: Why?, answered: Bool) {
        self.installed = installed
        self.version = version.flatMap(Self.validVersion)
        self.parts = IntegrationID.displayOrder.map { id in parts.first { $0.id == id } ?? Part(id: id, state: .unknown) }
        self.updateAvailable = updateAvailable
        self.updateWhy = updateAvailable ? nil : updateWhy
        self.answered = answered
    }

    public func part(_ id: IntegrationID) -> Part { parts.first { $0.id == id } ?? Part(id: id, state: .unknown) }

    /// The installer could not be asked or did not answer: every state unknown, nothing offered.
    public static let unknown = InstallStatus(installed: false, version: nil, parts: [], updateAvailable: false,
                                              updateWhy: nil, answered: false)

    /// No installed copy to ask (no scripts in `~/.wasitme/current`): what the installer itself says without a record.
    public static let notInstalled = InstallStatus(
        installed: false, version: nil,
        parts: IntegrationID.displayOrder.map { Part(id: $0, state: .unknown, why: .noInstallRecord) },
        updateAvailable: false, updateWhy: nil, answered: true)

    public static let schemaName = "wasitme.install-status"

    /// Parses the installer's answer; anything that is not a `wasitme.install-status/1` object gives `.unknown`.
    public static func parse(_ data: Data) -> InstallStatus {
        guard data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data), let doc = object as? [String: Any],
              let schema = doc["schema"] as? String, let id = SchemaID.parse(schema), id.name == schemaName, id.major == 1
        else { return .unknown }
        let installed = (doc["installed"] as? NSNumber).flatMap(strictBool) ?? false
        var parts: [Part] = []
        for item in (doc["integrations"] as? [Any] ?? []).prefix(32) {
            guard let d = item as? [String: Any], let raw = d["id"] as? String, let pid = IntegrationID(rawValue: raw),
                  !parts.contains(where: { $0.id == pid }) else { continue }
            let state = (d["state"] as? String).flatMap(State.init(rawValue:)) ?? .unknown
            parts.append(Part(id: pid, state: state, why: (d["why"] as? String).flatMap(Why.init(rawValue:))))
        }
        let update = doc["update"] as? [String: Any]
        let available = (update?["available"] as? NSNumber).flatMap(strictBool) ?? false
        return InstallStatus(installed: installed, version: doc["version"] as? String, parts: parts,
                             updateAvailable: available, updateWhy: (update?["why"] as? String).flatMap(Why.init(rawValue:)),
                             answered: true)
    }

    static func strictBool(_ n: NSNumber) -> Bool? {
        CFGetTypeID(n) == CFBooleanGetTypeID() ? n.boolValue : nil
    }

    static func validVersion(_ v: String) -> String? {
        guard (1...64).contains(v.count), v.unicodeScalars.allSatisfy({
            ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || "._+-".unicodeScalars.contains($0)
        }) else { return nil }
        return v
    }
}

/// How the last run the app started detached ended: `<wasitme>/state/last-action.json` (`wasitme.action/1`, written by
/// scripts/lib/from-app.mjs). `summary` is the run's last line: shown in a sheet, never sent to the page.
public struct ActionRecord: Equatable, Sendable {
    public enum Kind: String, Sendable { case update, add, uninstall, remove }
    public enum State: String, Sendable { case running, done, partial, stopped, failed }

    public let kind: Kind
    public let state: State
    public let code: Int?
    public let summary: String
    /// The detached run's pid while it runs (nil for the moment between its start and its first write).
    public let pid: pid_t?
    /// When it started, as the record says (ISO 8601); used to tell one run from the next, and its age only as a hint.
    public let started: String?
    public let finished: String?

    public static func parse(_ data: Data) -> ActionRecord? {
        guard data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data), let doc = object as? [String: Any],
              let schema = doc["schema"] as? String, let id = SchemaID.parse(schema), id.name == "wasitme.action", id.major == 1,
              let kind = (doc["action"] as? String).flatMap(Kind.init(rawValue:)),
              let state = (doc["state"] as? String).flatMap(State.init(rawValue:)) else { return nil }
        let code = (doc["code"] as? NSNumber).flatMap { InstallStatus.strictBool($0) == nil ? $0.intValue : nil }
        let pid = (doc["pid"] as? NSNumber).flatMap { n -> pid_t? in
            guard InstallStatus.strictBool(n) == nil, let v = pid_t(exactly: n.doubleValue), v > 0 else { return nil }
            return v
        }
        return ActionRecord(kind: kind, state: state, code: code,
                            summary: TextSanitizer.clean(doc["summary"] as? String ?? "", maxCharacters: 400),
                            pid: pid, started: (doc["started"] as? String).map { String($0.prefix(40)) },
                            finished: (doc["finished"] as? String).map { String($0.prefix(40)) })
    }

    public static func read(_ url: URL) -> ActionRecord? {
        guard let sig = FileSignature.of(url), sig.size <= 64 * 1024, let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    /// What this record says now. A "running" record whose pid is gone was cut short (a restart, say); one with no pid yet
    /// is `starting`, and only the caller's own clock can tell how long that has lasted.
    public func outcome(isAlive: (pid_t) -> Bool) -> ActionOutcome {
        switch state {
        case .running:
            guard let pid else { return .starting }
            return isAlive(pid) ? .running : .cutShort
        case .done: return .done(summary)
        case .partial: return .partial(summary)
        case .stopped: return .stopped(summary)
        case .failed: return .failed(code: code, summary)
        }
    }

    /// Still running for anyone who looks now: a live pid, or no pid yet and started less than a minute ago by `now`
    /// (from-app.mjs's own rule; a clock that went backward does not count as recent).
    public func isBusy(now: Date, isAlive: (pid_t) -> Bool) -> Bool {
        guard state == .running else { return false }
        if let pid { return isAlive(pid) }
        guard let started, let t = ContractDate.parse(started) else { return false }
        let age = now.timeIntervalSince(t)
        return age >= 0 && age < 60
    }
}

public enum ActionOutcome: Equatable, Sendable {
    case starting
    case running
    case done(String)
    /// A part failed and was rolled back (exit 3).
    case partial(String)
    /// The new Claude Code plugin hooks or calls more than the installed one; nothing was changed (exit 4).
    case stopped(String)
    case failed(code: Int?, String)
    /// The record says running, but its process is gone.
    case cutShort
    /// The caller stopped waiting while it was still running.
    case timedOut
    /// No record to read (a full uninstall deletes it; `--purge` deletes the folder).
    case missing

    public var isFinal: Bool {
        switch self {
        case .starting, .running: false
        default: true
        }
    }
}

/// `kill(pid, 0)`: the process exists (EPERM means it exists but is not ours, which still counts).
public enum ProcessLiveness {
    public static func isAlive(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
