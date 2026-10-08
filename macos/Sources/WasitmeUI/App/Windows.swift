import AppKit

// Window classes with the behaviours the spikes verified.

/// Borderless, key-capable panel for the menu bar drop-down (Codex Router pattern). Not
/// `MenuBarExtra(.window)`, which re-anchors on every state publish and can park itself in a corner.
/// Escape closes it (keyboard navigation).
public final class StatusPanel: NSPanel {
    /// Called for Escape / Cmd-. (`cancelOperation`).
    var onCancel: () -> Void = {}

    public init(size: CGSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .statusBar
        hasShadow = true
        isOpaque = false
        backgroundColor = .clear
        hidesOnDeactivate = false
        isMovable = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        setAccessibilitySubrole(.floatingWindow)
        setAccessibilityLabel("wasitme")
    }

    /// Borderless windows refuse key status by default; buttons inside need it.
    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { false }

    public override func cancelOperation(_ sender: Any?) { onCancel() }

    /// Escape (or ⌘.) closes the popover whatever has focus inside it: the SwiftUI hosting view takes key presses itself and
    /// never passes Escape on as `cancelOperation` (verified: PopoverKeyTests), so the panel catches it first.
    public override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, Self.isCancelKey(event) {
            onCancel()
            return
        }
        super.sendEvent(event)
    }

    static func isCancelKey(_ event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        return (event.keyCode == 53 && mods.isEmpty) || (event.charactersIgnoringModifiers == "." && mods == [.command])
    }
}

/// The desktop "widget": a borderless, non-activating panel just above the desktop icons, on every
/// Space, left out of Cmd-Tab and Mission Control cycling (spike: widgetkit-adhoc/Panel, verified).
/// A real WidgetKit widget is unproven with ad-hoc signing, so this is the safe fallback.
public final class DesktopPanel: NSPanel {
    public static var desktopLevel: NSWindow.Level {
        NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    }

    public init(size: CGSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        level = Self.desktopLevel
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        setAccessibilityLabel("wasitme desktop panel")
    }

    public override var canBecomeKey: Bool { false }
    public override var canBecomeMain: Bool { false }
}
