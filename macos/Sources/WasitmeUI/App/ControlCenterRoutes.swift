import Foundation
import WasitmeCore

/// Where each bridge decision goes (pure routing; tested with recording closures). A `.perform` runs its one in-app
/// effect; a `.confirm` only ever reaches `guarded` (the native sheet flow, `GuardedActionFlow`), never a performer
/// directly; a `.reject` does nothing.
@MainActor
struct ControlCenterRoutes {
    var render: () -> Void = {}
    var scanNow: () -> Void = {}
    var showPage: (ControlCenterPage) -> Void = { _ in }
    var selectAgent: (String) -> Void = { _ in }
    var copyReport: () -> Void = {}
    var openMarkdown: () -> Void = {}
    var setLaunchAtLogin: (Bool) -> Void = { _ in }
    var setDesktopPanel: (Bool) -> Void = { _ in }
    var revealDataFolder: () -> Void = {}
    var guarded: (GuardedAction) -> Void = { _ in }

    func route(_ decision: BridgeDecision) {
        switch decision {
        case .perform(.ready): render()
        case .perform(.scanNow): scanNow()
        case .perform(.showPage(let page)): showPage(page)
        case .perform(.selectAgent(let id)): selectAgent(id)
        case .perform(.copyReport): copyReport()
        case .perform(.openMarkdown): openMarkdown()
        case .perform(.setLaunchAtLogin(let on)): setLaunchAtLogin(on)
        case .perform(.setDesktopPanel(let on)): setDesktopPanel(on)
        case .perform(.revealDataFolder): revealDataFolder()
        case .confirm(let action): guarded(action)
        case .reject: break                        // counted by the handler; never acted on
        }
    }
}

/// The desktop panel as the Settings switch sees it (DesktopPanelController; a recorder in tests, so no test orders a
/// panel in).
@MainActor
protocol DesktopPanelControlling: AnyObject {
    var isVisible: Bool { get }
    func show()
    func hide()
    /// Called after the panel was shown or hidden, from anywhere (the switch, the status menu, the panel's own Hide).
    var onVisibilityChange: (() -> Void)? { get set }
}

/// "Show in Finder" for the saved history. The folder only; nothing in it is opened.
enum DataFolder {
    /// The folder to select, or nil when there is none yet (nothing has been saved).
    static func revealable(_ directory: WasitmeDirectory, fileManager: FileManager = .default) -> URL? {
        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: directory.url.path, isDirectory: &isDir), isDir.boolValue else { return nil }
        return directory.url
    }
}
