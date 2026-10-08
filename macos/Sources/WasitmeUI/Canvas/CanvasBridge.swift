import Foundation
import WasitmeCore

/// What the user calls each part, in a sentence ("Remove the status line"), and the installer's own flag that installs it
/// on a first run (`IntegrationID` itself lives in WasitmeCore with the commands that use it).
public extension IntegrationID {
    var title: String {
        switch self {
        case .app: "the menu bar app"
        case .scan: "the background scan"
        case .claudePlugin: "the Claude Code plugin"
        case .codexPlugin: "the Codex skill"
        case .statusline: "the status line"
        }
    }

    /// The installer flag that adds this part on an install (scripts/install.sh --help).
    var installerFlag: String { self == .scan ? "--scan-agent" : "--\(rawValue)" }
}

/// Changes to the user's setup that the canvas may only ASK for (the Settings page's buttons); the canvas never performs
/// them. Native code decides with `GuardedActionFlow`: a change the app cannot run right now gets an informational sheet
/// with the reason (never a confirmation it then refuses); a change that can run is confirmed in a native NSAlert first
/// (never a web `confirm()`), and runs only on the user's yes. The sheet's words are the app's own, never the page's.
public enum GuardedAction: Equatable, Hashable, Sendable {
    case removeIntegration(IntegrationID)
    case addIntegration(IntegrationID)
    case clearHistory
    case uninstallAll
    case updateApp
    /// An update stopped because the new Claude Code plugin hooks or calls more than the installed one (installer exit 4,
    /// nothing changed): the app asks again, naming that. Never posted by the page; the bridge cannot produce it.
    case updateAcceptingPluginChanges

    /// The uninstaller the installer leaves behind (scripts/uninstall.sh): asks before each part, keeps the history
    /// unless `--purge`. Only this native fallback sheet names it (`terminalSteps`, when no performer is wired); the
    /// canvas's Settings page never does (UX-V2 §9.1, CanvasTests).
    public static let uninstallCommand = "sh ~/.wasitme/current/scripts/uninstall.sh"

    /// Every request the page can post, once each. `addIntegration(.app)` is not one: the app is built from sources the
    /// installed copy does not keep, so only the installer adds it (the bridge rejects it).
    public static var all: [GuardedAction] {
        IntegrationID.allCases.flatMap { id -> [GuardedAction] in
            [.removeIntegration(id)] + (id.canBeAddedFromInstalledCopy ? [.addIntegration(id)] : [])
        } + [.clearHistory, .uninstallAll, .updateApp]
    }

    /// The bridge action name the canvas posts.
    public var actionName: String {
        switch self {
        case .removeIntegration: "removeIntegration"
        case .addIntegration: "addIntegration"
        case .clearHistory: "clearHistory"
        case .uninstallAll: "uninstallAll"
        case .updateApp, .updateAcceptingPluginChanges: "updateApp"
        }
    }

    /// The message the canvas posts for this action (an integration id travels as `integration`; UX-V2 §10.1's `id` is
    /// accepted too).
    public var message: [String: Any] {
        switch self {
        case .removeIntegration(let id), .addIntegration(let id): ["action": actionName, "integration": id.rawValue]
        default: ["action": actionName]
        }
    }

    /// The word `view.settings.busy` carries while this runs: the integration id, else the action name.
    public var busyWord: String {
        switch self {
        case .removeIntegration(let id), .addIntegration(let id): id.rawValue
        default: actionName
        }
    }

    /// Removes or deletes something: the confirmation is drawn as destructive.
    public var isDestructive: Bool {
        switch self {
        case .removeIntegration, .clearHistory, .uninstallAll: true
        case .addIntegration, .updateApp, .updateAcceptingPluginChanges: false
        }
    }

    // MARK: not available (the fallback when the app has no reason to give)

    public var heading: String {
        switch self {
        case .removeIntegration(let id): "Remove \(id.title) from Terminal"
        case .addIntegration(let id): "Add \(id.title) from Terminal"
        case .clearHistory: "Delete wasitme's history from Terminal"
        case .uninstallAll: "Uninstall wasitme from Terminal"
        case .updateApp, .updateAcceptingPluginChanges: "Update wasitme from Terminal"
        }
    }

    /// The command that deletes the history without uninstalling (engine `history clear`; it asks first on a terminal).
    public static let clearHistoryCommand = "wasitme history clear"

    /// Opens with "Not available in the app yet." and ends with "Nothing was changed."
    public var terminalSteps: String {
        let cmd = Self.uninstallCommand
        let body: String
        switch self {
        case .removeIntegration:
            body = "In Terminal, run:\n\n\(cmd)\n\nIt asks about each part; keep the ones you want."
        case .addIntegration(let id):
            body = "Run wasitme's installer again the way you installed it, and add \(id.installerFlag) to the command."
        case .clearHistory:
            body = "In Terminal, run:\n\n\(Self.clearHistoryCommand)\n\nIt asks before it deletes anything."
        case .uninstallAll:
            body = "In Terminal, run:\n\n\(cmd)\n\nIt asks before each part and keeps your history unless you add --purge."
        case .updateApp, .updateAcceptingPluginChanges:
            body = "In Terminal, run:\n\n\(WasitmeIdentity.updateCommand)\n\nIt shows the installed version and the one step that updates it."
        }
        return "Not available in the app yet. \(body) Nothing was changed."
    }

    /// The sheet for a change the app can't run right now, with the reason it has (UX-V2 §9.1: never a Terminal how-to
    /// when there is a reason to give).
    public func unavailable(_ reason: String) -> (heading: String, detail: String) {
        let what: String
        switch self {
        case .removeIntegration(let id): what = id == .scan ? "turn off \(id.title)" : "remove \(id.title)"
        case .addIntegration(let id): what = id == .scan ? "turn on \(id.title)" : "add \(id.title)"
        case .clearHistory: what = "clear the history"
        case .uninstallAll: what = "uninstall wasitme"
        case .updateApp, .updateAcceptingPluginChanges: what = "update wasitme"
        }
        return ("wasitme can't \(what) right now", "\(reason) Nothing was changed.")
    }

    // MARK: the confirmation (only for a change that can run; UX-V2 §9.3)

    public var confirmation: GuardedConfirmation { confirmation(note: nil) }

    /// `note`: what the installer said when an update stopped (only `updateAcceptingPluginChanges` uses it).
    public func confirmation(note: String?) -> GuardedConfirmation {
        switch self {
        case .addIntegration(.claudePlugin):
            GuardedConfirmation(question: "Add the Claude Code plugin?",
                                detail: "wasitme registers its plugin with Claude Code. Settings › Privacy lists everything it can do.",
                                button: "Add", destructive: false)
        case .addIntegration(.statusline):
            GuardedConfirmation(question: "Add the wasitme status line?",
                                detail: "Claude Code's settings file is backed up first, and your own status line is never replaced.",
                                button: "Add", destructive: false)
        case .addIntegration(.codexPlugin):
            GuardedConfirmation(question: "Add the Codex skill?",
                                detail: "Codex gets a skill that prints the wasitme report. It has no hooks.",
                                button: "Add", destructive: false)
        case .addIntegration(.scan):
            GuardedConfirmation(question: "Turn on the background scan?",
                                detail: "wasitme checks every 15 minutes, at low priority.",
                                button: "Turn On", destructive: false)
        case .addIntegration(.app):
            GuardedConfirmation(question: "Add the menu bar app?", detail: "The installer builds the app and puts it in Applications.",
                                button: "Add", destructive: false)
        case .removeIntegration(.app):
            GuardedConfirmation(question: "Remove the menu bar app?",
                                detail: "The menu bar icon and this window go away, and wasitme quits. The background scan, the plugins, the wasitme command and your history stay.",
                                button: "Remove", destructive: true)
        case .removeIntegration(.claudePlugin):
            GuardedConfirmation(question: "Remove the Claude Code plugin?",
                                detail: "Claude Code loses the /wasitme pane, and sessions no longer ask wasitme to check. Your history stays.",
                                button: "Remove", destructive: true)
        case .removeIntegration(.statusline):
            GuardedConfirmation(question: "Remove the wasitme status line?",
                                detail: "Your earlier status line comes back, if the setting is still wasitme's. Your history stays.",
                                button: "Remove", destructive: true)
        case .removeIntegration(.codexPlugin):
            GuardedConfirmation(question: "Remove the Codex skill?",
                                detail: "Codex loses the wasitme report skill. Your history stays.",
                                button: "Remove", destructive: true)
        case .removeIntegration(.scan):
            GuardedConfirmation(question: "Turn off the background scan?",
                                detail: "wasitme then checks only when you click Check Again. Your history stays.",
                                button: "Turn Off", destructive: true)
        case .clearHistory:
            GuardedConfirmation(question: "Clear wasitme's history?",
                                detail: "This deletes the numbers saved in ~/.wasitme. Your agent logs are not touched, and your settings and the install stay. The next check re-reads the logs still on this Mac; changes in logs that are gone can't come back.",
                                button: "Clear History", destructive: true)
        case .uninstallAll:
            GuardedConfirmation(question: "Uninstall wasitme?",
                                detail: "This removes the app, the background scan, the plugins, the status line it set and the wasitme command, and restores what it changed. Your agent logs are never touched. Your saved history in ~/.wasitme is kept unless you tick the box.",
                                button: "Uninstall", destructive: true, option: "Also delete my saved history")
        case .updateApp:
            GuardedConfirmation(question: "Update wasitme?",
                                detail: "The installer downloads the newer release, keeps the parts you have, and reopens wasitme.",
                                button: "Update", destructive: false)
        case .updateAcceptingPluginChanges:
            GuardedConfirmation(question: "Update with the new plugin?",
                                detail: [note.map { "The installer stopped: \(SettingsPerformer.ended($0))" },
                                         "The new Claude Code plugin hooks or calls more than the one you have. Nothing has changed yet. Settings › Privacy lists what it can do once it is installed."]
                                    .compactMap { $0 }.joined(separator: " "),
                                button: "Update", destructive: false)
        }
    }
}

/// The words of a native confirmation (NSAlert): the question, what happens and what is kept, the button that does it,
/// and an optional checkbox (off by default).
public struct GuardedConfirmation: Equatable, Sendable {
    public let question: String
    public let detail: String
    public let button: String
    /// Drawn as a destructive button (`hasDestructiveAction`), with Cancel as the default.
    public let destructive: Bool
    /// A checkbox under the text (uninstall: "Also delete my saved history"), off unless the user ticks it.
    public let option: String?

    public init(question: String, detail: String, button: String, destructive: Bool, option: String? = nil) {
        self.question = question; self.detail = detail; self.button = button; self.destructive = destructive; self.option = option
    }

    /// What the user answered.
    public enum Answer: Equatable, Sendable {
        case cancel
        /// The confirming button; `option` is the checkbox's state (false when there is none).
        case confirm(option: Bool)
    }
}

/// Named actions the canvas may send. Anything else is rejected.
public enum BridgeAction: Equatable, Sendable {
    /// The page loaded and defined `window.wasitme.render`; native sends the data.
    case ready
    case scanNow
    case showPage(ControlCenterPage)
    case selectAgent(String)
    /// "Copy evidence report": native puts the report's Markdown on the pasteboard (ReportExporter).
    case copyReport
    /// "Open as Markdown": native writes the Markdown to a private temp file and opens it in the default app for it.
    case openMarkdown
    /// The Settings page's launch-at-login switch (`LaunchAtLoginSwitch`). Not destructive, and only the user's click on
    /// it can send it; never registers a login item while the installer's LaunchAgent starts the app.
    case setLaunchAtLogin(Bool)
    /// The Settings page's desktop panel switch: shows or hides the panel. Changes nothing outside the app.
    case setDesktopPanel(Bool)
    /// "Show in Finder" for the saved history (`~/.wasitme`): selects the folder in a Finder window.
    case revealDataFolder
}

public enum BridgeDecision: Equatable, Sendable {
    case perform(BridgeAction)
    /// A change to the user's setup: only ever a native sheet (`GuardedActionFlow`), never run from here.
    case confirm(GuardedAction)
    case reject(String)
}

/// The bridge's rules as pure functions (tested without WebKit).
///
/// Data in: only `callAsyncJavaScript(BridgePolicy.renderBody, arguments: [...])`. The body is a constant
/// string literal; every value travels in `arguments`, so no JavaScript is ever built from strings (CI
/// greps for it). Both arguments are ONE JSON string each (D48): the page parses them, so a key like
/// `__proto__` is plain data there, never a prototype. Data out: `webkit.messageHandlers.wasitme.postMessage(
/// {action, ...})`, checked here: main frame only, our own origin only, a small object with known keys, a named action.
public enum BridgePolicy {
    public static let handlerName = "wasitme"

    /// The one script native code runs in the page. Never interpolated; data comes in as `snap`/`view`.
    public static let renderBody: StaticString = "return window.wasitme.render(snap, view);"

    static let allowedKeys: Set<String> = ["action", "page", "agent", "integration", "enabled", "id", "value"]

    /// Each action with the key sets it may carry besides `action` (exactly one of them); a message with any other key
    /// set is rejected. `id` and `value` are UX-V2 §10.1's names for `integration` and `enabled`: either spelling is
    /// accepted, never both in one message.
    static let actionKeys: [String: [Set<String>]] = [
        "ready": [[]], "scanNow": [[]], "copyReport": [[]], "openMarkdown": [[]], "revealDataFolder": [[]],
        "showPage": [["page"]], "selectAgent": [["agent"]],
        "setLaunchAtLogin": [["enabled"], ["value"]], "setDesktopPanel": [["enabled"], ["value"]],
        "removeIntegration": [["integration"], ["id"]], "addIntegration": [["integration"], ["id"]],
        "clearHistory": [[]], "uninstallAll": [[]], "updateApp": [[]],
    ]

    public static func decide(body: Any, originProtocol: String, originHost: String, isMainFrame: Bool) -> BridgeDecision {
        guard isMainFrame else { return .reject("not the main frame") }
        guard originProtocol.lowercased() == CanvasRouter.scheme, originHost.lowercased() == CanvasRouter.host else {
            return .reject("foreign origin")
        }
        guard let dict = body as? [String: Any] else { return .reject("not an object") }
        guard dict.count <= 3, Set(dict.keys).isSubset(of: allowedKeys) else { return .reject("unexpected keys") }
        guard let action = dict["action"] as? String, action.count <= 32 else { return .reject("no action") }
        guard let keySets = actionKeys[action] else { return .reject("unknown action") }
        guard keySets.contains(Set(dict.keys).subtracting(["action"])) else { return .reject("unexpected keys") }
        switch action {
        case "ready": return .perform(.ready)
        case "scanNow": return .perform(.scanNow)
        case "copyReport": return .perform(.copyReport)
        case "openMarkdown": return .perform(.openMarkdown)
        case "revealDataFolder": return .perform(.revealDataFolder)
        case "showPage":
            guard let raw = dict["page"] as? String, let page = ControlCenterPage(rawValue: raw) else { return .reject("unknown page") }
            return .perform(.showPage(page))
        case "selectAgent":
            guard let id = dict["agent"] as? String, (1...32).contains(id.count),
                  id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ".") })
            else { return .reject("bad agent id") }
            return .perform(.selectAgent(id))
        case "setLaunchAtLogin", "setDesktopPanel":
            guard let on = strictBool(dict["enabled"] ?? dict["value"]) else { return .reject("the value is not a boolean") }
            return .perform(action == "setLaunchAtLogin" ? .setLaunchAtLogin(on) : .setDesktopPanel(on))
        case "removeIntegration", "addIntegration":
            guard let raw = (dict["integration"] ?? dict["id"]) as? String, raw.count <= 32,
                  let id = IntegrationID(bridgeValue: raw) else { return .reject("unknown integration") }
            if action == "removeIntegration" { return .confirm(.removeIntegration(id)) }
            guard id.canBeAddedFromInstalledCopy else { return .reject("only the installer adds the app") }
            return .confirm(.addIntegration(id))
        case "clearHistory": return .confirm(.clearHistory)
        case "uninstallAll": return .confirm(.uninstallAll)
        case "updateApp": return .confirm(.updateApp)
        default: return .reject("unknown action")
        }
    }

    /// A JavaScript boolean only: WebKit hands one over as a CFBoolean NSNumber, and `as? Bool` alone would also take the
    /// numbers 0 and 1.
    static func strictBool(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    // MARK: data in

    /// The snapshot as ONE JSON string (D48): the app's own decoded model re-encoded (unknown values already mapped per
    /// the display rules), with every string and key passed through `TextSanitizer` again on the way in. No snapshot,
    /// or one that can't be encoded (NaN/Infinity never reach the page): the JSON text `null`.
    public static func snapshotArgument(_ snapshot: Snapshot?) -> String {
        guard let snapshot,
              let data = try? ContractDecoder.makeEncoder().encode(snapshot),
              let object = try? JSONSerialization.jsonObject(with: data) else { return "null" }
        return json(sanitized(object))
    }

    /// Strings cleaned (≤400 characters), keys cleaned (≤64), depth bounded.
    static func sanitized(_ value: Any, depth: Int = 0) -> Any {
        guard depth < 12 else { return NSNull() }
        switch value {
        case let s as String: return TextSanitizer.clean(s, maxCharacters: 400)
        case let a as [Any]: return a.prefix(2_000).map { sanitized($0, depth: depth + 1) }
        case let d as [String: Any]:
            var out: [String: Any] = [:]
            for (k, v) in d { out[TextSanitizer.clean(k, maxCharacters: 64)] = sanitized(v, depth: depth + 1) }
            return out
        case is NSNull, is NSNumber: return value
        default: return NSNull()
        }
    }

    /// JSON text for a plain object; "null" for anything JSONSerialization would refuse (it raises on NaN/Infinity,
    /// so validity is checked first).
    static func json(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Who draws the window's chrome. The app draws it natively (title bar, toolbar, sidebar with the pages, agent picker
    /// and "local only · updated …"), so the canvas draws only the page content.
    public static let chrome = "content"

    /// The `view` object: what native decided (page, agent, appearance, the moment and time zone the page should
    /// judge freshness and print times in) plus the display words for each agent. `chrome: "content"`: the app draws the
    /// sidebar, the canvas only the page. `launchAtLogin`: the Settings switch's state (`LaunchAtLoginState` raw value:
    /// on, off, needsApproval, viaInstaller, unavailable). Plain strings, numbers and booleans only.
    ///
    /// `settings` (UX-V2 §10.2, `SettingsState.viewObject`): what each Settings control shows, as codes. Omitted when the
    /// caller has none, so a page that predates it sees the same object as before.
    public static func viewObject(display: GlanceDisplay, page: ControlCenterPage, agentID: String?, dark: Bool,
                                  now: Date, timeZone: TimeZone, launchAtLogin: LaunchAtLoginState = .unavailable,
                                  settings: SettingsState? = nil) -> [String: Any] {
        var object: [String: Any] = [
            "page": page.rawValue,
            "pageTitle": page.title,
            "agent": agentID ?? display.primary?.id ?? "",
            "lead": display.lead.rawValue,
            "document": display.document.rawValue,
            "documentText": display.document == .ok ? "" : AppCopy.detail(display.document),
            "demo": display.demo,
            "appearance": dark ? "dark" : "light",
            "chrome": chrome,
            "launchAtLogin": launchAtLogin.rawValue,
            "now": ContractDate.format(now),
            "timeZone": TextSanitizer.clean(timeZone.identifier, maxCharacters: 64),
            "agents": display.agents.map { a -> [String: Any] in
                ["id": TextSanitizer.clean(a.id, maxCharacters: 32), "name": a.name, "stateText": a.stateText,
                 "headline": a.headline, "current": a.isCurrent]
            },
        ]
        if let settings { object["settings"] = settings.viewObject }
        return object
    }

    /// `viewObject` as ONE JSON string (D48, like the snapshot).
    public static func viewArgument(display: GlanceDisplay, page: ControlCenterPage, agentID: String?, dark: Bool,
                                    now: Date, timeZone: TimeZone, launchAtLogin: LaunchAtLoginState = .unavailable,
                                    settings: SettingsState? = nil) -> String {
        json(viewObject(display: display, page: page, agentID: agentID, dark: dark, now: now, timeZone: timeZone,
                        launchAtLogin: launchAtLogin, settings: settings))
    }
}
