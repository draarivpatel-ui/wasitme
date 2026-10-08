import Darwin
import Foundation

/// The parts of an install the Settings page can add or remove, by the id the installer's `--status`, `--add` and the
/// uninstaller's `--only` all accept. `scan` is the background scan (the installer's own install flag for it is
/// `--scan-agent`; `--add scan` and `--only scan` take this name too).
public enum IntegrationID: String, CaseIterable, Sendable {
    case app
    case scan
    case claudePlugin = "claude-plugin"
    case codexPlugin = "codex-plugin"
    case statusline

    /// The order of `install.sh --status` and of the Settings rows (UX-V2 §9.2).
    public static let displayOrder: [IntegrationID] = [.app, .claudePlugin, .statusline, .codexPlugin, .scan]

    /// An id from the page: one of the raw values, or `scan-agent` (the installer's own name for the scan) for `scan`.
    public init?(bridgeValue raw: String) {
        if raw == "scan-agent" { self = .scan; return }
        self.init(rawValue: raw)
    }

    /// `app` is built from sources the installed copy does not keep, so only the installer can add it.
    public var canBeAddedFromInstalledCopy: Bool { self != .app }
}

/// Where the installer and uninstaller of this install live, and the flag that points them at its folder.
///
/// The scripts are `<wasitme folder>/current/scripts/{install,uninstall}.sh`: the folder that holds `engine.json`, never
/// a path read from a page or a log. The installer knows a folder only as `<home>/.wasitme`, so a folder with another name
/// cannot be managed from the app (nil). For the user's own `~/.wasitme` no `--home` is passed: `--home` puts the
/// installer in sandbox mode, which never touches launchd.
public struct SetupLocation: Equatable, Sendable {
    public let directory: WasitmeDirectory
    /// `[]` for the user's own `~/.wasitme`; `["--home", <parent>]` for a `.wasitme` folder elsewhere (tests, sandboxes).
    public let homeArguments: [String]

    public init?(directory: WasitmeDirectory, userHome: URL = FileManager.default.homeDirectoryForCurrentUser) {
        let dir = directory.url.standardizedFileURL
        guard dir.lastPathComponent == ".wasitme" else { return nil }
        let parent = dir.deletingLastPathComponent().standardizedFileURL.path
        guard parent.hasPrefix("/"), !parent.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return nil }
        self.directory = directory
        homeArguments = parent == userHome.standardizedFileURL.path ? [] : ["--home", parent]
    }

    public var scriptsDirectory: URL {
        directory.url.appendingPathComponent("current", isDirectory: true).appendingPathComponent("scripts", isDirectory: true)
    }
    public var installScript: URL { scriptsDirectory.appendingPathComponent("install.sh", isDirectory: false) }
    public var uninstallScript: URL { scriptsDirectory.appendingPathComponent("uninstall.sh", isDirectory: false) }
    /// What `--from-app` hands the run to (scripts/lib/from-app.mjs); without it a detached run cannot start.
    public var fromAppHelper: URL {
        scriptsDirectory.appendingPathComponent("lib", isDirectory: true).appendingPathComponent("from-app.mjs", isDirectory: false)
    }
    /// How the last detached run ended (`wasitme.action/1`, written by from-app.mjs).
    public var actionRecord: URL {
        directory.url.appendingPathComponent("state", isDirectory: true).appendingPathComponent("last-action.json", isDirectory: false)
    }

    /// The scripts this install would run are there and trustworthy (`ScriptFile.isTrusted`).
    public var scriptsPresent: Bool {
        ScriptFile.isTrusted(installScript) && ScriptFile.isTrusted(uninstallScript) && ScriptFile.isTrusted(fromAppHelper)
    }
}

/// A script the app is about to hand to `/bin/sh` (or node): a regular file once symlinks are followed (`current` is one),
/// owned by this user, and writable by nobody else. The installer writes them that way (umask 022).
public enum ScriptFile {
    public static func isTrusted(_ url: URL) -> Bool {
        var st = stat()
        guard stat(url.path, &st) == 0 else { return false }
        return (st.st_mode & S_IFMT) == S_IFREG && st.st_uid == getuid() && (st.st_mode & (S_IWGRP | S_IWOTH)) == 0
    }
}

/// The installer and uninstaller runs the Settings page can start. Each is a fixed argument list built from the closed
/// `IntegrationID` enum; nothing from a page reaches a command line. Every run that can touch the app's own LaunchAgent
/// carries `--from-app`: it then runs detached in its own session (scripts/lib/from-app.mjs), so it survives the app
/// being quit or its job being unloaded, and the call returns at once.
public enum SetupCommand: Equatable, Hashable, Sendable {
    /// `install.sh --status --json`: reads only, synchronous.
    case status
    /// `install.sh --add <id> --from-app`: one part from the installed copy, no download.
    case add(IntegrationID)
    /// `uninstall.sh --yes --only <id> --from-app`: one part; the rest and the history stay.
    case remove(IntegrationID)
    /// `uninstall.sh --yes [--purge] --from-app`: everything; the history too only with `purge`.
    case uninstallAll(purge: Bool)
    /// `install.sh --update [--accept-plugin-changes] --from-app`: the newer release with the parts installed now.
    case update(acceptPluginChanges: Bool)

    public enum Script: Sendable { case install, uninstall }

    public var script: Script {
        switch self {
        case .status, .add, .update: .install
        case .remove, .uninstallAll: .uninstall
        }
    }

    /// The flags after the script path (before `SetupLocation.homeArguments`).
    public var arguments: [String] {
        switch self {
        case .status: ["--status", "--json"]
        case .add(let id): ["--add", id.rawValue, "--from-app"]
        case .remove(let id): ["--yes", "--only", id.rawValue, "--from-app"]
        case .uninstallAll(let purge): ["--yes"] + (purge ? ["--purge"] : []) + ["--from-app"]
        case .update(let accept): ["--update"] + (accept ? ["--accept-plugin-changes"] : []) + ["--from-app"]
        }
    }

    /// `add(.app)` has no command: the app is built from sources the installed copy does not keep.
    public var isSupported: Bool {
        if case .add(let id) = self { return id.canBeAddedFromInstalledCopy }
        return true
    }

    /// Runs detached (`--from-app`): the call only says whether it started; the outcome is in the action record.
    public var runsDetached: Bool { self != .status }

    /// The app quits once this has started: it removes the app itself (the uninstaller waits for it to go).
    public var quitsApp: Bool {
        switch self {
        case .remove(.app), .uninstallAll: true
        default: false
        }
    }

    /// `/bin/sh` is exec'd directly (no shell string): this is its whole argv after the executable.
    public func argv(in location: SetupLocation) -> [String]? {
        guard isSupported else { return nil }
        let script = script == .install ? location.installScript : location.uninstallScript
        return [script.path] + arguments + location.homeArguments
    }

    /// The shell every run uses, by absolute path (a GUI app has no useful PATH).
    public static let shell = URL(fileURLWithPath: "/bin/sh")
}
