import CoreGraphics

/// One display, as the placement function sees it. All rectangles are in AppKit's global screen
/// coordinates (origin bottom-left, the primary display's bottom-left at (0, 0); displays to the left
/// of or below the primary have negative coordinates). Build these from `NSScreen` at the call site:
///
///     ScreenGeometry(frame: s.frame, visibleFrame: s.visibleFrame, topSafeAreaInset: s.safeAreaInsets.top)
public struct ScreenGeometry: Equatable, Sendable {
    /// The display's full frame.
    public var frame: CGRect
    /// The frame minus the menu bar and Dock (`NSScreen.visibleFrame`).
    public var visibleFrame: CGRect
    /// Height of the camera-housing (notch) band reserved at the top of the display; 0 on displays
    /// without a notch (`NSScreen.safeAreaInsets.top`).
    public var topSafeAreaInset: CGFloat

    public init(frame: CGRect, visibleFrame: CGRect? = nil, topSafeAreaInset: CGFloat = 0) {
        self.frame = frame
        self.visibleFrame = visibleFrame ?? frame
        self.topSafeAreaInset = topSafeAreaInset
    }
}

/// Pure placement of the drop-down panel under a menu bar item (the Codex Router pattern: a
/// borderless `NSPanel` positioned by a tested function, instead of `MenuBarExtra(.window)`, which
/// re-anchors on every state publish and can park itself in a screen corner).
public enum PanelPlacement {
    public struct Options: Equatable, Sendable {
        /// Space between the bottom of the menu bar item and the top of the panel.
        public var gap: CGFloat = 6
        /// Minimum distance kept to the edges of the visible frame.
        public var margin: CGFloat = 8
        /// The panel is shrunk (never moved off-screen) when the screen is too short, but not below
        /// this, unless the visible frame itself leaves less room than that.
        public var minimumHeight: CGFloat = 120
        public init(gap: CGFloat = 6, margin: CGFloat = 8, minimumHeight: CGFloat = 120) {
            self.gap = gap; self.margin = margin; self.minimumHeight = minimumHeight
        }
    }

    public struct Result: Equatable, Sendable {
        /// Where to put the panel (always inside the chosen screen's visible frame).
        public var frame: CGRect
        /// Index into the `screens` array that was chosen; nil only when `screens` was empty.
        public var screenIndex: Int?
        /// X offset of the menu bar item's centre from the panel's left edge, for a caret or arrow.
        /// Clamped into the panel's width.
        public var anchorX: CGFloat
        /// True when the item frame was unusable (zero-sized, non-finite, or on no display - e.g. a
        /// status item macOS hid because the menu bar was full) and the panel was parked at the
        /// top-right of the primary display instead.
        public var usedFallbackAnchor: Bool
    }

    /// - Parameters:
    ///   - statusItemFrame: the status item button's frame in screen coordinates.
    ///   - panelSize: the panel's preferred size.
    ///   - screens: all displays; index 0 is treated as the primary display (as `NSScreen.screens` does).
    public static func place(
        statusItemFrame item: CGRect,
        panelSize size: CGSize,
        screens: [ScreenGeometry],
        options: Options = Options()
    ) -> Result {
        let size = CGSize(width: finitePositive(size.width), height: finitePositive(size.height))
        guard !screens.isEmpty else {
            // No display information at all: hang from the item with no clamping.
            let valid = isUsable(item)
            let x = valid ? item.midX - size.width / 2 : 0
            let top = valid ? item.minY - options.gap : size.height
            let frame = CGRect(x: x, y: top - size.height, width: size.width, height: size.height)
            return Result(frame: frame, screenIndex: nil, anchorX: size.width / 2, usedFallbackAnchor: !valid)
        }

        let itemUsable = isUsable(item)
        let chosen = itemUsable ? screenIndex(containing: item, in: screens) : nil
        let usedFallback = chosen == nil
        let index = chosen ?? 0
        let screen = screens[index]

        let area = screen.visibleFrame
        let margin = max(0, options.margin)
        let innerMinX = area.minX + margin
        let innerMaxX = area.maxX - margin

        // Width: never wider than the usable span.
        let width = max(0, min(size.width, innerMaxX - innerMinX))

        // Horizontal: centre under the item, then clamp. A hidden/unusable item anchors top-right.
        var x: CGFloat
        if usedFallback {
            x = innerMaxX - width
        } else {
            x = item.midX - width / 2
            x = min(max(x, innerMinX), max(innerMinX, innerMaxX - width))
        }

        // Vertical: the top edge hangs below the item, but never above the visible frame or into the
        // notch band, even when the menu bar is auto-hidden (visibleFrame then reaches the screen top).
        let notchLimit = screen.frame.maxY - max(0, screen.topSafeAreaInset)
        let ceiling = min(area.maxY, notchLimit)
        let top = usedFallback ? ceiling - options.gap : min(item.minY - options.gap, ceiling)
        // Height: shrink to fit above the bottom margin, but not below `minimumHeight`; the visible
        // frame's bottom edge is a hard limit that always wins (the margin is only soft there).
        let softAvailable = top - (area.minY + margin)
        let hardAvailable = max(0, top - area.minY)
        var height = max(min(size.height, options.minimumHeight), min(size.height, softAvailable))
        height = min(height, hardAvailable)
        let y = top - height

        let frame = CGRect(x: x, y: y, width: width, height: height)
        let anchorX = usedFallback ? width - min(width, 20) : min(max(item.midX - x, 0), width)
        return Result(frame: frame, screenIndex: index, anchorX: anchorX, usedFallbackAnchor: usedFallback)
    }

    /// Convenience when only the frame is needed.
    public static func frame(
        statusItemFrame: CGRect, panelSize: CGSize, screens: [ScreenGeometry], options: Options = Options()
    ) -> CGRect {
        place(statusItemFrame: statusItemFrame, panelSize: panelSize, screens: screens, options: options).frame
    }

    // MARK: - Screen choice (pure, testable without AppKit)

    /// The display an item belongs to: the one containing the item's centre; otherwise the one with
    /// the largest overlap; otherwise nil (the item is on no display).
    public static func screenIndex(containing item: CGRect, in screens: [ScreenGeometry]) -> Int? {
        let mid = CGPoint(x: item.midX, y: item.midY)
        if let i = screens.firstIndex(where: { contains($0.frame, mid) }) { return i }
        var best: (index: Int, area: CGFloat)?
        for (i, s) in screens.enumerated() {
            let overlap = s.frame.intersection(item)
            guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { continue }
            let area = overlap.width * overlap.height
            if best == nil || area > best!.area { best = (i, area) }
        }
        return best?.index
    }

    /// Inclusive point-in-rect (CGRect.contains excludes the max edges; a menu bar item touches the
    /// top edge of its display).
    static func contains(_ r: CGRect, _ p: CGPoint) -> Bool {
        p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
    }

    static func isUsable(_ r: CGRect) -> Bool {
        r.origin.x.isFinite && r.origin.y.isFinite && r.size.width.isFinite && r.size.height.isFinite
            && r.width > 0 && r.height > 0
    }

    private static func finitePositive(_ v: CGFloat) -> CGFloat { v.isFinite && v > 0 ? v : 0 }
}
