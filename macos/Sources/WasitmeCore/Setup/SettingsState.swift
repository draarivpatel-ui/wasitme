import Foundation

/// What the Settings page shows for each control, as the app knows it (UX-V2 §10.2): sent to the canvas as
/// `view.settings`. Codes only, never a sentence or a path: the page picks every word it shows from these.
///
///     "settings": { "version": "0.1.0", "installed": true, "answered": true,
///                   "integrations": [{ "id": "app", "state": "on" }, { "id": "codex-plugin", "state": "unavailable",
///                                      "why": "agent_missing" }, ...],
///                   "desktopPanel": true, "launchAtLogin": true | false | null,
///                   "update": { "available": false, "why": "no_release" },
///                   "canClearHistory": true, "busy": null | "<id or action>" }
public struct SettingsState: Equatable, Sendable {
    public var status: InstallStatus
    public var desktopPanel: Bool
    public var launchAtLogin: LaunchAtLoginState
    /// engine.json is usable, so Clear History can run.
    public var canClearHistory: Bool
    /// What is running now: an integration id (adding or removing it), or `clearHistory`, `uninstallAll`, `updateApp`,
    /// or `addIntegration` / `removeIntegration` for a run another copy of the app started. nil: nothing.
    public var busy: String?

    public init(status: InstallStatus, desktopPanel: Bool, launchAtLogin: LaunchAtLoginState, canClearHistory: Bool,
                busy: String? = nil) {
        self.status = status
        self.desktopPanel = desktopPanel
        self.launchAtLogin = launchAtLogin
        self.canClearHistory = canClearHistory
        self.busy = busy
    }

    /// Before the installer has been asked: every state unknown, nothing offered.
    public static let initial = SettingsState(status: .unknown, desktopPanel: false, launchAtLogin: .unavailable,
                                              canClearHistory: false)

    /// The switch's position: on (including "the installer's LaunchAgent does it" and "registered, waiting for your
    /// approval"; the top-level `view.launchAtLogin` word says which), off, or null when the app can't tell.
    public var launchAtLoginValue: Bool? {
        switch launchAtLogin {
        case .on, .needsApproval, .viaInstaller: true
        case .off: false
        case .unavailable: nil
        }
    }

    /// The busy word for a run another copy of the app started (only its kind is known).
    public static func busyWord(for kind: ActionRecord.Kind) -> String {
        switch kind {
        case .update: "updateApp"
        case .uninstall: "uninstallAll"
        case .add: "addIntegration"
        case .remove: "removeIntegration"
        }
    }

    /// Plain strings, booleans, NSNull, arrays and dictionaries only.
    public var viewObject: [String: Any] {
        var update: [String: Any] = ["available": status.updateAvailable]
        if let why = status.updateWhy { update["why"] = why.rawValue }
        return [
            "version": status.version.map { $0 as Any } ?? NSNull(),
            "installed": status.installed,
            "answered": status.answered,
            "integrations": status.parts.map { p -> [String: Any] in
                var d: [String: Any] = ["id": p.id.rawValue, "state": p.state.rawValue]
                if let why = p.why { d["why"] = why.rawValue }
                return d
            },
            "desktopPanel": desktopPanel,
            "launchAtLogin": launchAtLoginValue.map { $0 as Any } ?? NSNull(),
            "update": update,
            "canClearHistory": canClearHistory,
            "busy": busy.map { $0 as Any } ?? NSNull(),
        ]
    }
}
