import AppKit
import WasitmeCore

/// The app's main menu. It is installed at launch and shows in the menu bar only while the Control Center is open (the app
/// is a regular app then, an accessory app otherwise). The app's own commands go to `target` (the Control Center
/// controller); the standard ones go up the responder chain, so Copy / Select All work in the canvas, Toggle Sidebar
/// reaches the split view and Minimize / Zoom / Full Screen the window.
@MainActor
enum MainMenu {
    static func make(target: AnyObject) -> NSMenu {
        let main = NSMenu(title: "Main Menu")

        let app = submenu(of: main, AppCopy.productName)
        app.addItem(item("About wasitme", #selector(ControlCenterController.showAbout(_:)), target: target))
        app.addItem(.separator())
        app.addItem(item("Settings…", #selector(ControlCenterController.showSettings(_:)), ",", target: target))
        app.addItem(.separator())
        app.addItem(item("Hide wasitme", #selector(NSApplication.hide(_:)), "h"))
        app.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        app.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        app.addItem(.separator())
        app.addItem(item("Quit wasitme", #selector(NSApplication.terminate(_:)), "q"))

        let file = submenu(of: main, "File")
        file.addItem(item("Copy Report", #selector(ControlCenterController.copyReport(_:)), "c", [.command, .shift], target: target))
        file.addItem(item("Open Report as Markdown", #selector(ControlCenterController.openMarkdown(_:)), target: target))
        file.addItem(.separator())
        file.addItem(item("Close", #selector(NSWindow.performClose(_:)), "w"))

        let edit = submenu(of: main, "Edit")
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))

        let view = submenu(of: main, "View")
        view.addItem(item("Check Again", #selector(ControlCenterController.checkAgain(_:)), "r", target: target))
        view.addItem(.separator())
        for (i, page) in ControlCenterPage.allCases.enumerated() {
            let p = item(page.title, #selector(ControlCenterController.showPageFromMenu(_:)), "\(i + 1)", target: target)
            p.tag = i
            view.addItem(p)
        }
        view.addItem(.separator())
        view.addItem(item("Show Sidebar", #selector(NSSplitViewController.toggleSidebar(_:)), "s", [.command, .control]))
        view.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))

        let window = submenu(of: main, "Window")
        window.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        window.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        window.addItem(.separator())
        window.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))

        let help = submenu(of: main, "Help")
        help.addItem(item(HelpDoc.readme.menuTitle, #selector(ControlCenterController.openReadme(_:)), "?", target: target))
        help.addItem(item(HelpDoc.method.menuTitle, #selector(ControlCenterController.openMethod(_:)), target: target))
        return main
    }

    /// Puts the menu in place, with the Window and Help menus AppKit manages (window list, Help search).
    static func install(target: AnyObject) {
        let menu = make(target: target)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = menu.item(withTitle: "Window")?.submenu
        NSApp.helpMenu = menu.item(withTitle: "Help")?.submenu
    }

    private static func submenu(of main: NSMenu, _ title: String) -> NSMenu {
        let menu = NSMenu(title: title)
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        main.addItem(holder)
        return menu
    }

    private static func item(_ title: String, _ action: Selector, _ key: String = "",
                             _ modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if !key.isEmpty { item.keyEquivalentModifierMask = modifiers }
        item.target = target
        return item
    }
}

/// The documents Help opens: the copies that come with the installed version (`<wasitme home>/current/…`), opened in the
/// Mac's default app for Markdown. Nothing is fetched; when a copy isn't there, the app says where it is instead.
public enum HelpDoc: CaseIterable, Sendable {
    case readme, method

    public var menuTitle: String {
        switch self {
        case .readme: "wasitme Help"
        case .method: "How wasitme Decides"
        }
    }

    /// Where the installed version keeps it, relative to `<home>/current`.
    public var relativePath: String {
        switch self {
        case .readme: "README.md"
        case .method: "docs/METHOD.md"
        }
    }

    /// The installed copy, if there is one.
    public func installedCopy(home: WasitmeDirectory, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> URL? {
        let url = home.url.appendingPathComponent("current", isDirectory: true).appendingPathComponent(relativePath, isDirectory: false)
        return fileExists(url.path) ? url : nil
    }

    /// Whether Help lists it: the README always (its sheet says where it is when this copy lacks it); the method only when
    /// this copy has it (release copies don't carry docs/, scripts/release.sh), so the menu never offers a dead end.
    public func isShown(home: WasitmeDirectory, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
        self == .readme || installedCopy(home: home, fileExists: fileExists) != nil
    }

    /// The sheet when there is no installed copy (or no app opened it): where to find it.
    public func whereItIs(home: WasitmeDirectory) -> (text: String, detail: String) {
        let place = (home.url.appendingPathComponent("current", isDirectory: true).appendingPathComponent(relativePath).path as NSString)
            .abbreviatingWithTildeInPath
        switch self {
        case .readme:
            return ("The README isn't in this copy of wasitme",
                    "Installed versions keep it at \(place). It is also the front page of wasitme's source.")
        case .method:
            return ("How wasitme decides",
                    "The method is written up in docs/METHOD.md in wasitme's source; installed versions keep it at \(place) when they include it.")
        }
    }
}

/// The standard About panel: name, version, the licence line and the privacy line.
@MainActor
enum AboutPanel {
    static func version(bundle: Bundle = .main) -> String {
        let v = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return v.map { TextSanitizer.clean($0, maxCharacters: 32) }.flatMap { $0.isEmpty ? nil : $0 } ?? "development build"
    }

    static let creditsText = "MIT License. \(Tokens.Copy.privacyLine)"

    static func options(bundle: Bundle = .main) -> [NSApplication.AboutPanelOptionKey: Any] {
        [
            .applicationName: AppCopy.productName,
            .applicationVersion: version(bundle: bundle),
            .version: "",
            .credits: NSAttributedString(string: creditsText, attributes: theme.chrome.aboutCreditsAttributes),
        ]
    }
}
