import AppKit
import ServiceManagement
import WasitmeCore

/// Whether a change can run from the app right now.
public enum GuardedAvailability: Equatable, Sendable {
    case available
    /// It can't, for this reason (one sentence, shown in the sheet). nil: no reason known; the sheet gives the Terminal
    /// steps instead.
    case unavailable(String?)
}

/// Proof that the user said yes to a change in its native sheet. Only `GuardedActionFlow` can make one (the initialiser
/// is fileprivate to this file), so a performer can never be asked to run something that skipped the confirmation.
public struct GuardedConsent: Equatable, Sendable {
    public let action: GuardedAction
    /// The sheet's checkbox (uninstall: "Also delete my saved history"); false when the sheet had none.
    public let option: Bool

    fileprivate init(action: GuardedAction, option: Bool) {
        self.action = action
        self.option = option
    }
}

/// Runs the Settings page's changes to the user's setup (add or remove a part, clear the history, uninstall, update).
/// The app's is `SettingsPerformer`; `NotWiredPerformer` answers "not available" to everything.
@MainActor
public protocol GuardedActionPerforming: AnyObject {
    /// Whether this change can run from the app now, and why not.
    func availability(_ action: GuardedAction) -> GuardedAvailability
    /// Runs the change the user confirmed.
    func perform(_ consent: GuardedConsent) async -> GuardedActionResult
}

public extension GuardedActionPerforming {
    /// True only when this change can run from the app now.
    func canPerform(_ action: GuardedAction) -> Bool { availability(action) == .available }
}

public enum GuardedActionResult: Equatable, Sendable {
    /// Finished; the page re-renders with what is true now. No sheet.
    case done
    /// Finished, and a sheet says so.
    case report(String, detail: String?)
    /// Didn't work: a sheet with the tool's reason.
    case failed(String, detail: String?)
    /// The app quits now (the change removes it); no sheet.
    case quitting
    /// Ask before going on: `next`, with what the installer said.
    case confirmNext(GuardedAction, note: String)
}

/// The performer with nothing behind it: every change is unavailable, so every request ends in an informational sheet
/// and nothing runs.
@MainActor
public final class NotWiredPerformer: GuardedActionPerforming {
    public init() {}
    public func availability(_ action: GuardedAction) -> GuardedAvailability { .unavailable(nil) }
    public func perform(_ consent: GuardedConsent) async -> GuardedActionResult {
        .failed("Not available in the app yet.", detail: "Nothing was changed.")
    }
}

/// What the app shows for a guarded request (pure; tested).
public enum GuardedPlan: Equatable, Sendable {
    /// The change can't run from the app now: an informational sheet (the reason, or the Terminal steps). Never a
    /// confirmation.
    case inform(heading: String, detail: String)
    /// The change can run: a native confirmation first, then the change only on the user's yes.
    case confirm(GuardedConfirmation)

    public static func plan(_ action: GuardedAction, available: Bool) -> GuardedPlan {
        plan(action, availability: available ? .available : .unavailable(nil))
    }

    public static func plan(_ action: GuardedAction, availability: GuardedAvailability, note: String? = nil) -> GuardedPlan {
        switch availability {
        case .available:
            return .confirm(action.confirmation(note: note))
        case .unavailable(let reason?):
            let u = action.unavailable(reason)
            return .inform(heading: u.heading, detail: u.detail)
        case .unavailable(nil):
            return .inform(heading: action.heading, detail: action.terminalSteps)
        }
    }
}

/// The sheets, behind an interface so the flow is tested without AppKit.
@MainActor
public protocol AlertPresenting: AnyObject {
    func inform(_ text: String, detail: String?)
    /// `.confirm` only when the user chose the confirming button (with the checkbox's state); anything else is `.cancel`.
    func confirm(_ confirmation: GuardedConfirmation) async -> GuardedConfirmation.Answer
}

/// The one path a guarded request takes: plan, then either an informational sheet, or a native confirmation and the
/// change. Nothing reaches the performer without the user's yes in that sheet (`GuardedConsent`).
@MainActor
public final class GuardedActionFlow {
    public let performer: any GuardedActionPerforming
    let presenter: any AlertPresenting

    public init(performer: any GuardedActionPerforming, presenter: any AlertPresenting) {
        self.performer = performer
        self.presenter = presenter
    }

    public func handle(_ action: GuardedAction, note: String? = nil) async {
        switch GuardedPlan.plan(action, availability: performer.availability(action), note: note) {
        case .inform(let heading, let detail):
            presenter.inform(heading, detail: detail)
        case .confirm(let confirmation):
            guard case .confirm(let option) = await presenter.confirm(confirmation) else { return }
            // The sheet may have been open a while: if the change can't run any more (another one started, say), say so.
            let now = performer.availability(action)
            guard now == .available else {
                if case .inform(let heading, let detail) = GuardedPlan.plan(action, availability: now) {
                    presenter.inform(heading, detail: detail)
                }
                return
            }
            let consent = GuardedConsent(action: action, option: confirmation.option != nil && option)
            switch await performer.perform(consent) {
            case .done, .quitting: break
            case .report(let text, let detail), .failed(let text, let detail): presenter.inform(text, detail: detail)
            case .confirmNext(let next, let note): await handle(next, note: note)
            }
        }
    }
}

/// The sheet (if any) after the launch-at-login switch was flipped (pure; tested). `on` and `off` need none: the switch
/// itself shows the new state.
public struct LaunchAtLoginSheet: Equatable, Sendable {
    public let text: String
    public let detail: String
    /// Offers "Open Login Items" (System Settings opens only if the user clicks it).
    public let offersLoginItems: Bool

    public static let openLoginItemsButton = "Open Login Items"
    public static let notNowButton = "Not Now"

    public static func after(_ outcome: LaunchAtLoginOutcome) -> LaunchAtLoginSheet? {
        switch outcome {
        case .on, .off:
            return nil
        case .needsApproval:
            return LaunchAtLoginSheet(
                text: "Allow wasitme to open at login",
                detail: "macOS asks you to allow it first: turn wasitme on in System Settings > General > Login Items.",
                offersLoginItems: true)
        case .viaInstaller:
            return LaunchAtLoginSheet(
                text: "wasitme already opens at login",
                detail: "Its installer set that up with the menu bar app, so nothing was changed. Removing the menu bar app part of the install stops it.",
                offersLoginItems: false)
        case .unavailable:
            return LaunchAtLoginSheet(
                text: "Launch at login isn't available for this copy",
                detail: "It works for the wasitme app the installer puts in your Applications folder. Nothing was changed.",
                offersLoginItems: false)
        case .failed(let why):
            return LaunchAtLoginSheet(text: "Couldn't change launch at login", detail: "\(why) Nothing was changed.",
                                      offersLoginItems: false)
        }
    }
}

/// The real sheets: NSAlert on the Control Center window, only ever after the user's own click.
@MainActor
final class WindowAlertPresenter: AlertPresenting {
    private let window: () -> NSWindow?

    init(window: @escaping () -> NSWindow?) { self.window = window }

    func inform(_ text: String, detail: String?) {
        guard let window = window(), window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = text
        if let detail { alert.informativeText = detail }
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    /// The confirming button first, then Cancel (NSAlert gives a button titled Cancel the Escape key). A destructive one
    /// is drawn as such, and Return answers Cancel. A checkbox, when the confirmation has one, starts off. No visible
    /// window, or a sheet already open on it: nothing is asked and the answer is Cancel.
    func confirm(_ c: GuardedConfirmation) async -> GuardedConfirmation.Answer {
        guard let window = window(), window.isVisible, window.attachedSheet == nil else { return .cancel }
        let (alert, box) = Self.alert(for: c)
        let response = await alert.beginSheetModal(for: window)
        guard response == .alertFirstButtonReturn else { return .cancel }
        return .confirm(option: box?.state == .on)
    }

    /// The confirmation's NSAlert, not shown (the sheet above, and `--capture`, which draws it offscreen): the confirming
    /// button first, then Cancel; a destructive one drawn so, with Return on Cancel; the checkbox, if any, off.
    static func alert(for c: GuardedConfirmation) -> (alert: NSAlert, checkbox: NSButton?) {
        let alert = NSAlert()
        alert.messageText = c.question
        alert.informativeText = c.detail
        alert.alertStyle = c.destructive ? .warning : .informational
        let yes = alert.addButton(withTitle: c.button)
        let cancel = alert.addButton(withTitle: "Cancel")
        if c.destructive {
            yes.hasDestructiveAction = true
            yes.keyEquivalent = ""
            cancel.keyEquivalent = "\r"
        }
        var box: NSButton?
        if let option = c.option {
            let b = NSButton(checkboxWithTitle: option, target: nil, action: nil)
            b.state = .off
            b.sizeToFit()
            alert.accessoryView = b
            box = b
        }
        return (alert, box)
    }

    /// The launch-at-login sheet; "Open Login Items" opens System Settings only when clicked.
    func show(_ sheet: LaunchAtLoginSheet) {
        guard let window = window(), window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = sheet.text
        alert.informativeText = sheet.detail
        alert.alertStyle = .informational
        if sheet.offersLoginItems {
            alert.addButton(withTitle: LaunchAtLoginSheet.openLoginItemsButton)
            alert.addButton(withTitle: LaunchAtLoginSheet.notNowButton)
        } else {
            alert.addButton(withTitle: "OK")
        }
        alert.beginSheetModal(for: window) { response in
            if sheet.offersLoginItems && response == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
        }
    }
}
