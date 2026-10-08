import AppKit
import Foundation
import SwiftUI
import Testing
@testable import WasitmeCore
@testable import WasitmeUI

/// The Control Center as a normal Mac window: built headless (never ordered in, never key, the app never activates).
@Suite @MainActor struct ControlCenterWindowTests {
    func model(_ file: String = "snapshot/you-and-codex.json") throws -> ControlCenterModel {
        let entry = try #require(Repo.manifest.first { $0.file == file })
        return ControlCenterModel(display: try #require(Repo.display(entry)), snapshot: nil)
    }

    func make(_ model: ControlCenterModel, reduceMotion: Bool = false) -> (NSWindow, ControlCenterSplitController, ControlCenterContentView) {
        let content = ControlCenterContentView(size: Theme.current.metrics.controlCenter)
        let toolbar = ControlCenterToolbar(target: nil)
        let (w, split) = ControlCenterWindow.make(model: model, content: content, toolbar: toolbar, reduceMotion: reduceMotion)
        return (w, split, content)
    }

    /// A standard title bar (draggable, double-click zooms as System Settings says) with a unified toolbar and the title
    /// shown; no full-size content view, so the web view never sits under the title bar or the window buttons.
    @Test func aStandardTitledWindowWithAUnifiedToolbar() throws {
        _ = Headless.ready
        let visibleBefore = NSApp.windows.filter(\.isVisible).count
        let (w, _, content) = make(try model())
        #expect(!w.styleMask.contains(.fullSizeContentView))
        #expect(w.styleMask.isSuperset(of: [.titled, .closable, .miniaturizable, .resizable]))
        #expect(w.toolbarStyle == .unified && w.titleVisibility == .visible && !w.titlebarAppearsTransparent)
        #expect(w.isMovable && !w.isMovableByWindowBackground, "moved by its title bar and toolbar, like any window")
        #expect(w.tabbingMode == .disallowed, "no tab bar items in the View menu")
        #expect(w.collectionBehavior.contains(.fullScreenPrimary))
        #expect(w.frameAutosaveName == ControlCenterWindow.autosaveName)
        #expect(w.contentMinSize.width >= Theme.current.metrics.controlCenterMinimum.width
                && w.contentMinSize.height >= Theme.current.metrics.controlCenterMinimum.height)
        #expect(w.contentMinSize.width >= Theme.current.chrome.sidebarMaximum + Theme.current.chrome.contentMinimum)
        // Everything in the content view is inside the content layout rect: nothing under the title bar or toolbar.
        let contentView = try #require(w.contentView)
        #expect(abs(w.contentLayoutRect.height - contentView.bounds.height) < 0.5 && abs(w.contentLayoutRect.width - contentView.bounds.width) < 0.5)
        #expect(content.window === w, "the canvas column is in this window")
        #expect(NSApp.windows.filter(\.isVisible).count == visibleBefore, "building the window never shows it")
        #expect(!w.isVisible && !w.isKeyWindow)
    }

    /// The designed size: the page area below the toolbar is the token size, and the sidebar starts at its ideal width.
    /// The `--capture` copy is built the same way and keeps no frame or sidebar width in the user's defaults.
    @Test func opensAtTheDesignedSize() throws {
        _ = Headless.ready
        let size = Theme.current.metrics.controlCenter
        let content = ControlCenterContentView(size: size)
        let (w, split) = ControlCenterWindow.make(model: try model(), content: content, toolbar: ControlCenterToolbar(target: nil),
                                                  reduceMotion: false, forCapture: true)
        w.layoutIfNeeded()
        #expect(abs(w.contentLayoutRect.width - size.width) < 0.5 && abs(w.contentLayoutRect.height - size.height) < 0.5,
                "\(w.contentLayoutRect)")
        #expect(abs(split.sidebarItem.viewController.view.frame.width - Theme.current.chrome.sidebarIdeal) < 1,
                "\(split.sidebarItem.viewController.view.frame)")
        // The canvas column takes the rest of the width. How much the divider and the column's inset take differs by macOS
        // version (0 to 8 points on the versions CI and development use), so allow that, and never more than the rest.
        let rest = size.width - Theme.current.chrome.sidebarIdeal
        #expect(content.frame.width <= rest + 1 && content.frame.width > rest - 10, "\(content.frame)")
        #expect(w.frameAutosaveName.isEmpty && split.splitView.autosaveName == nil)
        #expect(!w.isVisible)
    }

    /// The page title is the window title (toolbar, Window menu, VoiceOver); the agent is the subtitle.
    @Test func titleIsThePageAndSubtitleTheAgent() throws {
        _ = Headless.ready
        let m = try model()
        let (w, _, _) = make(m)
        #expect(w.title == m.page.title && w.subtitle == m.selectedAgent?.name)
        m.page = .settings
        m.agentID = "codex"
        ControlCenterWindow.apply(model: m, to: w)
        #expect(w.title == "Settings" && w.subtitle == "Codex")
        let empty = try model("snapshot/empty.json")
        ControlCenterWindow.apply(model: empty, to: w)
        #expect(w.subtitle == "", "no agent, no subtitle")
    }

    /// Native sidebar beside the canvas: a sidebar split item (system material, collapsible) and the canvas column.
    @Test func sidebarAndCanvasColumns() throws {
        _ = Headless.ready
        let (_, split, content) = make(try model())
        #expect(split.splitViewItems.count == 2)
        #expect(split.splitViewItems.first?.behavior == .sidebar && split.sidebarItem.canCollapse)
        #expect(split.sidebarItem.minimumThickness == Theme.current.chrome.sidebarMinimum
                && split.sidebarItem.maximumThickness == Theme.current.chrome.sidebarMaximum)
        #expect(split.contentItem.behavior == .default && split.contentItem.viewController.view === content)
        #expect(split.sidebarItem.viewController is NSHostingController<ControlCenterSidebar>)
    }

    /// Reduce Motion: the sidebar collapses and comes back without animating, and windows open without the zoom animation.
    @Test func reduceMotionCollapsesTheSidebarInstantly() throws {
        _ = Headless.ready
        let (w, split, _) = make(try model(), reduceMotion: true)
        #expect(w.animationBehavior == .none)
        split.reduceMotion = { true }
        #expect(!split.sidebarItem.isCollapsed)
        split.toggleSidebar(nil)
        #expect(split.sidebarItem.isCollapsed, "collapsed at once, not after an animation")
        split.toggleSidebar(nil)
        #expect(!split.sidebarItem.isCollapsed)
        let (normal, _, _) = make(try model(), reduceMotion: false)
        #expect(normal.animationBehavior == .documentWindow)
        #expect(Theme.current.motion.windowAnimation(reduceMotion: true) == .none)
    }

    /// The toolbar: the sidebar toggle leading (before the title), then Check Again, Open as Markdown and Copy Report,
    /// each an SF Symbol with a label and a tooltip, sending its action to the target.
    @Test func toolbarItems() throws {
        _ = Headless.ready
        let target = NSObject()
        let delegate = ControlCenterToolbar(target: target)
        let bar = NSToolbar(identifier: ControlCenterToolbar.identifier)
        #expect(delegate.toolbarDefaultItemIdentifiers(bar) == [ControlCenterToolbar.sidebar, .flexibleSpace,
                                                                 ControlCenterToolbar.checkAgain, ControlCenterToolbar.openMarkdown,
                                                                 ControlCenterToolbar.copyReport])
        #expect(!delegate.toolbarDefaultItemIdentifiers(bar).contains(.sidebarTrackingSeparator),
                "a tracking separator only lines up with the sidebar in a full-size-content window")
        let toggle = try #require(delegate.toolbar(bar, itemForItemIdentifier: ControlCenterToolbar.sidebar, willBeInsertedIntoToolbar: true))
        #expect(toggle.isNavigational && toggle.target == nil && toggle.image != nil && toggle.toolTip?.isEmpty == false)
        #expect(toggle.action == #selector(NSSplitViewController.toggleSidebar(_:)), "up the responder chain to the split view")
        #expect(ControlCenterController.instancesRespond(to: #selector(NSSplitViewController.toggleSidebar(_:))),
                "the window's delegate forwards it when the window itself is the first responder")
        let want: [(NSToolbarItem.Identifier, String, Selector)] = [
            (ControlCenterToolbar.checkAgain, "Check Again", #selector(ControlCenterController.checkAgain(_:))),
            (ControlCenterToolbar.openMarkdown, "Open as Markdown", #selector(ControlCenterController.openMarkdown(_:))),
            (ControlCenterToolbar.copyReport, "Copy Report", #selector(ControlCenterController.copyReport(_:))),
        ]
        for (id, label, action) in want {
            let item = try #require(delegate.toolbar(bar, itemForItemIdentifier: id, willBeInsertedIntoToolbar: true))
            #expect(item.label == label && item.image != nil && item.toolTip?.isEmpty == false)
            #expect(item.action == action && item.target === target)
        }
        #expect(delegate.toolbar(bar, itemForItemIdentifier: .flexibleSpace, willBeInsertedIntoToolbar: true) == nil, "system item")
    }

    /// Every SF Symbol the chrome names exists on this macOS (else the toolbar would show a blank button).
    @Test func everySymbolResolves() {
        for name in Theme.current.chrome.allSymbols {
            #expect(Theme.current.chrome.image(name, label: name) != nil, "\(name)")
        }
        #expect(Set(ControlCenterPage.allCases.map(Theme.current.chrome.symbol(for:))).count == ControlCenterPage.allCases.count,
                "one symbol per page")
    }

    /// The sidebar footer: "Local only · updated …", "Checking…" while a check runs, just "Local only" with no time.
    @Test func sidebarFooter() throws {
        let m = try model()
        #expect(m.sidebarFooter.hasPrefix("Local only · updated "))
        m.scanning = true
        #expect(m.sidebarFooter == "Checking…")
        let mismatch = GlanceDisplay.make(status: .updateNeeded(found: "wasitme.glance/9"), glance: nil, now: Date(timeIntervalSince1970: 0))
        #expect(mismatch.document == .mismatch && mismatch.sidebarFooter == "Local only")
        #expect(GlanceDisplay.make(status: .notLoaded, glance: nil, now: Date(timeIntervalSince1970: 0)).sidebarFooter == "Local only")
    }

    /// The sidebar draws (offscreen) in both appearances.
    @Test func sidebarRendersInBothAppearances() throws {
        _ = Headless.ready
        let m = try model()
        let size = CGSize(width: Theme.current.chrome.sidebarIdeal, height: 600)
        let light = try #require(Offscreen.png(ControlCenterSidebar(model: m), size: size, dark: false))
        let dark = try #require(Offscreen.png(ControlCenterSidebar(model: m), size: size, dark: true))
        #expect(light != dark)
    }
}

@Suite @MainActor struct MainMenuTests {
    let target = NSObject()

    func items(_ menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { [$0] + ($0.submenu.map(items) ?? []) }
    }

    func find(_ menu: NSMenu, _ action: Selector, tag: Int? = nil) -> NSMenuItem? {
        items(menu).first { $0.action == action && (tag == nil || $0.tag == tag) }
    }

    @Test func standardMenusInOrder() {
        let menu = MainMenu.make(target: target)
        #expect(menu.items.map(\.title) == ["wasitme", "File", "Edit", "View", "Window", "Help"])
    }

    /// Every shortcut the brief names, with its modifiers.
    @Test func keyEquivalents() throws {
        let menu = MainMenu.make(target: target)
        let cc = ControlCenterController.self
        let cases: [(Selector, String, NSEvent.ModifierFlags, Bool)] = [
            (#selector(cc.showSettings(_:)), ",", [.command], true),
            (#selector(NSApplication.hide(_:)), "h", [.command], false),
            (#selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], false),
            (#selector(NSApplication.terminate(_:)), "q", [.command], false),
            (#selector(cc.copyReport(_:)), "c", [.command, .shift], true),
            (#selector(NSWindow.performClose(_:)), "w", [.command], false),
            (#selector(NSText.copy(_:)), "c", [.command], false),
            (#selector(NSText.paste(_:)), "v", [.command], false),
            (#selector(NSText.selectAll(_:)), "a", [.command], false),
            (#selector(cc.checkAgain(_:)), "r", [.command], true),
            (#selector(NSSplitViewController.toggleSidebar(_:)), "s", [.command, .control], false),
            (#selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control], false),
            (#selector(NSWindow.performMiniaturize(_:)), "m", [.command], false),
            (#selector(cc.openReadme(_:)), "?", [.command], true),
        ]
        for (action, key, mods, ours) in cases {
            let item = try #require(find(menu, action), "\(action)")
            #expect(item.keyEquivalent == key && item.keyEquivalentModifierMask == mods, "\(action): \(item.keyEquivalent)")
            #expect(ours ? item.target === target : item.target == nil, "\(action): our commands go to the controller, standard ones up the chain")
        }
        for action in [#selector(cc.showAbout(_:)), #selector(cc.openMarkdown(_:)), #selector(cc.openMethod(_:)),
                       #selector(NSWindow.performZoom(_:)), #selector(NSApplication.arrangeInFront(_:))] {
            #expect(find(menu, action) != nil, "\(action)")
        }
        #expect(items(menu).filter { $0.action == #selector(NSWindow.toggleFullScreen(_:)) }.count == 1, "one Enter Full Screen item")
    }

    /// View: ⌘1–⌘7 open the pages in sidebar order.
    @Test func pageShortcuts() throws {
        let menu = MainMenu.make(target: target)
        for (i, page) in ControlCenterPage.allCases.enumerated() {
            let item = try #require(find(menu, #selector(ControlCenterController.showPageFromMenu(_:)), tag: i))
            #expect(item.title == page.title && item.keyEquivalent == "\(i + 1)" && item.keyEquivalentModifierMask == [.command])
        }
        #expect(ControlCenterPage.allCases.count == 7)
    }

    @Test func aboutSaysNameVersionLicenceAndPrivacy() {
        let o = AboutPanel.options()
        #expect(o[.applicationName] as? String == "wasitme")
        #expect((o[.applicationVersion] as? String)?.isEmpty == false)
        let credits = (o[.credits] as? NSAttributedString)?.string ?? ""
        #expect(credits.contains("MIT License") && credits.contains(Tokens.Copy.privacyLine))
    }
}

@Suite struct HelpDocTests {
    /// Help opens the copy the installed version carries, and only a local file.
    @Test func findsTheInstalledCopies() throws {
        let tmp = try TempDir("help")
        let home = WasitmeDirectory(tmp.url.appendingPathComponent(".wasitme", isDirectory: true))
        #expect(HelpDoc.readme.installedCopy(home: home) == nil && HelpDoc.method.installedCopy(home: home) == nil)
        #expect(HelpDoc.readme.isShown(home: home) && !HelpDoc.method.isShown(home: home),
                "the method item is hidden while this copy has no docs/METHOD.md")
        let current = home.url.appendingPathComponent("current", isDirectory: true)
        try FileManager.default.createDirectory(at: current.appendingPathComponent("docs"), withIntermediateDirectories: true)
        try Data("# wasitme".utf8).write(to: current.appendingPathComponent("README.md"))
        let readme = try #require(HelpDoc.readme.installedCopy(home: home))
        #expect(readme.isFileURL && readme.lastPathComponent == "README.md")
        #expect(HelpDoc.method.installedCopy(home: home) == nil)
        try Data("# Method".utf8).write(to: current.appendingPathComponent("docs/METHOD.md"))
        #expect(HelpDoc.method.installedCopy(home: home)?.lastPathComponent == "METHOD.md")
        #expect(HelpDoc.method.isShown(home: home))
    }

    /// No copy: say where it is (never fetch it).
    @Test func saysWhereItIsWhenThereIsNoCopy() {
        let home = WasitmeDirectory(URL(fileURLWithPath: "/tmp/wasitme-help-none/.wasitme", isDirectory: true))
        for doc in HelpDoc.allCases {
            let (text, detail) = doc.whereItIs(home: home)
            #expect(!text.isEmpty && detail.contains(doc.relativePath), "\(doc)")
        }
        #expect(HelpDoc.method.whereItIs(home: home).detail.contains("docs/METHOD.md"))
    }
}

/// A presenter that records what it was asked to show and answers confirmations as told (`option`: the checkbox).
@MainActor final class RecordingPresenter: AlertPresenting {
    var answer: Bool
    var option: Bool
    var informed: [String] = []
    var details: [String?] = []
    var confirmed: [GuardedConfirmation] = []
    init(answer: Bool, option: Bool = false) { self.answer = answer; self.option = option }
    func inform(_ text: String, detail: String?) { informed.append(text); details.append(detail) }
    func confirm(_ c: GuardedConfirmation) async -> GuardedConfirmation.Answer {
        confirmed.append(c)
        return answer ? .confirm(option: option) : .cancel
    }
}

@MainActor final class RecordingPerformer: GuardedActionPerforming {
    var performed: [GuardedAction] = []
    var consents: [GuardedConsent] = []
    var result: GuardedActionResult = .report("Done.", detail: nil)
    func availability(_ action: GuardedAction) -> GuardedAvailability { .available }
    func perform(_ consent: GuardedConsent) async -> GuardedActionResult {
        performed.append(consent.action)
        consents.append(consent)
        return result
    }
}

@Suite @MainActor struct GuardedActionFlowTests {
    /// This build wires nothing: every request is a how-to sheet, never a confirmation, and nothing runs.
    @Test func unwiredChangesNeverAskToConfirm() async {
        let presenter = RecordingPresenter(answer: true)
        let flow = GuardedActionFlow(performer: NotWiredPerformer(), presenter: presenter)
        for a in GuardedAction.all { await flow.handle(a) }
        #expect(presenter.confirmed.isEmpty, "no confirm-then-refuse sheet")
        #expect(presenter.informed == GuardedAction.all.map(\.heading))
        #expect(GuardedAction.all.allSatisfy { !NotWiredPerformer().canPerform($0) })
    }

    /// Once wired: the native confirmation comes first, and the change runs only on the user's yes.
    @Test func wiredChangesRunOnlyAfterANativeYes() async {
        let performer = RecordingPerformer()
        let no = RecordingPresenter(answer: false)
        await GuardedActionFlow(performer: performer, presenter: no).handle(.uninstallAll)
        #expect(no.confirmed == [GuardedAction.uninstallAll.confirmation] && performer.performed.isEmpty && no.informed.isEmpty)
        let yes = RecordingPresenter(answer: true)
        await GuardedActionFlow(performer: performer, presenter: yes).handle(.removeIntegration(.statusline))
        #expect(yes.confirmed == [GuardedAction.removeIntegration(.statusline).confirmation])
        #expect(performer.performed == [.removeIntegration(.statusline)] && yes.informed == ["Done."])
    }

    /// The real presenter's confirmation is an NSAlert (never a web confirm(), which the canvas lockdown always answers no).
    @Test func confirmationsAreNativeSheets() throws {
        let source = try String(contentsOf: Repo.uiSources.appendingPathComponent("App/GuardedActions.swift"), encoding: .utf8)
        #expect(source.contains("NSAlert()") && source.contains("beginSheetModal(for: window)"))
        #expect(source.contains("hasDestructiveAction = true") && source.contains("cancel.keyEquivalent = \"\\r\""),
                "a destructive button is drawn so, and Return answers Cancel")
    }
}

@Suite struct LaunchAtLoginSheetTests {
    /// Only approval offers to open System Settings (Login Items), and only through a button the user clicks.
    @Test func sheetsAfterEachOutcome() throws {
        #expect(LaunchAtLoginSheet.after(.on) == nil && LaunchAtLoginSheet.after(.off) == nil)
        let approval = try #require(LaunchAtLoginSheet.after(.needsApproval))
        #expect(approval.offersLoginItems && approval.detail.contains("Login Items"))
        for o: LaunchAtLoginOutcome in [.unavailable("x"), .failed("The system refused.")] {
            let s = try #require(LaunchAtLoginSheet.after(o))
            #expect(!s.offersLoginItems && s.detail.hasSuffix("Nothing was changed."), "\(o)")
        }
        let installer = try #require(LaunchAtLoginSheet.after(.viaInstaller))
        #expect(!installer.offersLoginItems && installer.detail.contains("nothing was changed"))
        #expect(LaunchAtLoginSheet.after(.failed("The system refused."))?.detail.hasPrefix("The system refused.") == true)
    }
}

@Suite @MainActor struct PopoverKeyTests {
    /// A real Escape key press, sent to the popover panel with SwiftUI content inside, closes it.
    @Test func escapeKeyPressClosesThePopover() throws {
        _ = Headless.ready
        let panel = StatusPanel(size: Theme.current.metrics.popover)
        let entry = try #require(Repo.manifest.first)
        let display = try #require(Repo.display(entry))
        panel.contentView = NSHostingView(rootView: PopoverView(display: display, actions: .inert))
        var closed = 0
        panel.onCancel = { closed += 1 }
        let esc = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                                windowNumber: panel.windowNumber, context: nil, characters: "\u{1b}",
                                                charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
        panel.sendEvent(esc)
        #expect(closed == 1)
        let a = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                              windowNumber: panel.windowNumber, context: nil, characters: "a",
                                              charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0))
        panel.sendEvent(a)
        #expect(closed == 1, "other keys don't close it")
    }
}
