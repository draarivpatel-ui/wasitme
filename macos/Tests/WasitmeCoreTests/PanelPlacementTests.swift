import CoreGraphics
import Testing
@testable import WasitmeCore

/// Compare CGFloats via a helper: `#expect(x == 950 - 6)` types the right side as Int inside the
/// Testing macros and compared unequal to an equal CGFloat on this toolchain.
private func near(_ a: CGFloat, _ b: CGFloat, tolerance: CGFloat = 0.001) -> Bool { abs(a - b) <= tolerance }

/// Geometry fixtures. AppKit coordinates: origin bottom-left, primary display at (0, 0).
private enum Rig {
    /// 14" notched laptop display: 32pt menu bar band, which is also the notch inset.
    static let notchedLaptop = ScreenGeometry(
        frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
        visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 950),
        topSafeAreaInset: 32)
    /// External display to the right of the laptop, taller, 25pt menu bar, Dock on the bottom (70pt).
    static let externalRight = ScreenGeometry(
        frame: CGRect(x: 1512, y: -200, width: 2560, height: 1440),
        visibleFrame: CGRect(x: 1512, y: -130, width: 2560, height: 1345))
    /// Second display to the LEFT of the primary (negative x), Dock on the left (80pt wide).
    static let leftOfPrimary = ScreenGeometry(
        frame: CGRect(x: -1920, y: 0, width: 1920, height: 1080),
        visibleFrame: CGRect(x: -1840, y: 0, width: 1840, height: 1055))
    /// Display stacked ABOVE the primary.
    static let above = ScreenGeometry(
        frame: CGRect(x: 0, y: 982, width: 1920, height: 1080),
        visibleFrame: CGRect(x: 0, y: 982, width: 1920, height: 1055))

    /// A status item sitting in the menu bar band at the top of `screen`.
    static func item(on screen: ScreenGeometry, x: CGFloat, width: CGFloat = 30) -> CGRect {
        let band = screen.frame.maxY - screen.visibleFrame.maxY
        let h = max(band, 24)
        return CGRect(x: x, y: screen.frame.maxY - h, width: width, height: h)
    }

    static let panel = CGSize(width: 340, height: 420)
}

@Suite struct PanelPlacementTests {
    @Test func centresUnderTheItemWithAGap() {
        let screen = Rig.notchedLaptop
        let item = Rig.item(on: screen, x: 900)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [screen])
        #expect(r.frame.midX == item.midX)
        #expect(r.frame.size == Rig.panel)
        #expect(r.frame.maxY == item.minY - 6)
        #expect(r.screenIndex == 0)
        #expect(r.anchorX == Rig.panel.width / 2)
        #expect(!r.usedFallbackAnchor)
    }

    @Test func clampsAtTheRightEdgeKeepingTheCaretOnTheItem() {
        let screen = Rig.notchedLaptop
        let item = Rig.item(on: screen, x: 1480, width: 28)     // right-most menu bar item
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [screen])
        #expect(r.frame.maxX == screen.visibleFrame.maxX - 8)
        #expect(r.frame.width == Rig.panel.width)
        #expect(abs((r.frame.minX + r.anchorX) - item.midX) < 0.001, "caret still points at the item")
    }

    @Test func clampsAtTheLeftEdge() {
        let screen = Rig.notchedLaptop
        let item = Rig.item(on: screen, x: 4)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [screen])
        #expect(r.frame.minX == screen.visibleFrame.minX + 8)
    }

    @Test func respectsAVerticalDockOnTheSide() {
        let screen = Rig.leftOfPrimary          // visible frame starts 80pt in
        let item = Rig.item(on: screen, x: -1900)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [Rig.notchedLaptop, screen])
        #expect(r.screenIndex == 1)
        #expect(r.frame.minX == screen.visibleFrame.minX + 8)
    }

    // MARK: multiple displays

    @Test func staysOnTheDisplayThatOwnsTheItem() {
        let screens = [Rig.notchedLaptop, Rig.externalRight]
        // Item near the left end of the external display; the centred panel would hang over the laptop.
        let item = Rig.item(on: Rig.externalRight, x: 1520)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: screens)
        #expect(r.screenIndex == 1)
        #expect(r.frame.minX == Rig.externalRight.visibleFrame.minX + 8)
        #expect(Rig.externalRight.visibleFrame.contains(r.frame))
    }

    @Test func menuBarOnTheSecondaryDisplayWithDifferentGeometry() {
        // "Displays have separate Spaces": the active menu bar (and status item) can be on display 2,
        // which has a different height, origin and menu bar thickness than the primary.
        let screens = [Rig.notchedLaptop, Rig.externalRight]
        let item = Rig.item(on: Rig.externalRight, x: 3900)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: screens)
        #expect(r.screenIndex == 1)
        #expect(r.frame.maxY == item.minY - 6)
        #expect(r.frame.maxY <= Rig.externalRight.visibleFrame.maxY)
        #expect(r.frame.maxX == Rig.externalRight.visibleFrame.maxX - 8)
    }

    @Test func displayAboveThePrimary() {
        let screens = [Rig.notchedLaptop, Rig.above]
        let item = Rig.item(on: Rig.above, x: 1000)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: screens)
        #expect(r.screenIndex == 1)
        #expect(Rig.above.visibleFrame.contains(r.frame))
    }

    @Test func itemCentredInAGapBetweenDisplaysGoesToTheOneWithMostOverlap() {
        let a = ScreenGeometry(frame: CGRect(x: 0, y: 0, width: 1000, height: 800))
        let b = ScreenGeometry(frame: CGRect(x: 1100, y: 0, width: 1000, height: 800))
        // Centres at x=1010 and x=1095 are both in the 100pt gap; overlap decides.
        #expect(PanelPlacement.screenIndex(containing: CGRect(x: 990, y: 776, width: 40, height: 24), in: [a, b]) == 0)
        #expect(PanelPlacement.screenIndex(containing: CGRect(x: 1070, y: 776, width: 50, height: 24), in: [a, b]) == 1)
        // Overlaps nothing at all: no display.
        #expect(PanelPlacement.screenIndex(containing: CGRect(x: 1020, y: 776, width: 20, height: 24), in: [a, b]) == nil)
    }

    @Test func itemTouchingTheTopEdgeStillBelongsToItsDisplay() {
        let screens = [Rig.notchedLaptop]
        // Centre exactly on the top edge (y = 981 + 1 = 982 = maxY): containment is inclusive.
        let item = CGRect(x: 100, y: 981, width: 20, height: 2)
        #expect(PanelPlacement.screenIndex(containing: item, in: screens) == 0)
    }

    // MARK: notch

    @Test func panelNeverReachesIntoTheNotchBand() {
        let screen = Rig.notchedLaptop
        // Menu bar auto-hidden in a full-screen app: visibleFrame reaches the very top of the display.
        let fullscreen = ScreenGeometry(frame: screen.frame, visibleFrame: screen.frame, topSafeAreaInset: 32)
        let item = CGRect(x: 1300, y: 982 - 24, width: 30, height: 24)   // revealed bar, 24pt thick
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [fullscreen])
        #expect(r.frame.maxY <= fullscreen.frame.maxY - 32)
    }

    @Test func notchedDisplayWithNormalMenuBarUsesTheBandBottom() {
        let screen = Rig.notchedLaptop
        let item = Rig.item(on: screen, x: 1200)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [screen])
        #expect(near(r.frame.maxY, 950 - 6))
        #expect(r.frame.maxY <= screen.frame.maxY - screen.topSafeAreaInset)
    }

    // MARK: size limits

    @Test func shrinksTheHeightOnAShortScreenInsteadOfLeavingIt() {
        let short = ScreenGeometry(frame: CGRect(x: 0, y: 0, width: 800, height: 400),
                                   visibleFrame: CGRect(x: 0, y: 0, width: 800, height: 376))
        let item = CGRect(x: 400, y: 376, width: 22, height: 24)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [short])
        #expect(r.frame.minY == 8)
        #expect(near(r.frame.maxY, 376 - 6))
        #expect(near(r.frame.height, 376 - 6 - 8))
        #expect(r.frame.height < Rig.panel.height)
    }

    @Test func neverShrinksBelowTheMinimumHeight() {
        let tiny = ScreenGeometry(frame: CGRect(x: 0, y: 0, width: 800, height: 150))
        let item = CGRect(x: 400, y: 126, width: 22, height: 24)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [tiny])
        #expect(r.frame.height == 120)
    }

    @Test func narrowScreenShrinksTheWidth() {
        let narrow = ScreenGeometry(frame: CGRect(x: 0, y: 0, width: 300, height: 800))
        let item = CGRect(x: 150, y: 776, width: 22, height: 24)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [narrow])
        #expect(near(r.frame.width, 300 - 16))
        #expect(r.frame.minX == 8)
    }

    // MARK: hidden / invalid items

    @Test func hiddenOffscreenItemParksTopRightOfPrimary() {
        // macOS parks status items that do not fit (notch Macs with crowded menu bars) far off screen.
        let screens = [Rig.notchedLaptop, Rig.externalRight]
        let item = CGRect(x: -9000, y: 950, width: 30, height: 32)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: screens)
        #expect(r.usedFallbackAnchor)
        #expect(r.screenIndex == 0)
        #expect(r.frame.maxX == Rig.notchedLaptop.visibleFrame.maxX - 8)
        #expect(r.frame.maxY <= Rig.notchedLaptop.visibleFrame.maxY)
        #expect(Rig.notchedLaptop.visibleFrame.contains(r.frame))
    }

    @Test(arguments: [CGRect.zero, CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 10)])
    func unusableItemFrameFallsBackSafely(_ item: CGRect) {
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [Rig.notchedLaptop])
        #expect(r.usedFallbackAnchor)
        #expect(r.frame.origin.x.isFinite && r.frame.origin.y.isFinite)
        #expect(Rig.notchedLaptop.visibleFrame.contains(r.frame))
    }

    @Test func noScreensStillReturnsAFiniteFrame() {
        let item = CGRect(x: 500, y: 900, width: 30, height: 30)
        let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: [])
        #expect(r.screenIndex == nil)
        #expect(near(r.frame.midX, 500 + 15))
        #expect(near(r.frame.maxY, 900 - 6))
        let none = PanelPlacement.place(statusItemFrame: .zero, panelSize: Rig.panel, screens: [])
        #expect(none.frame.width == 340 && none.frame.origin.x.isFinite)
    }

    @Test func garbagePanelSizeDoesNotProduceNaN() {
        let r = PanelPlacement.place(statusItemFrame: Rig.item(on: Rig.notchedLaptop, x: 800),
                                     panelSize: CGSize(width: CGFloat.nan, height: -5), screens: [Rig.notchedLaptop])
        #expect(r.frame.width == 0 && r.frame.height == 0)
        #expect(r.frame.origin.x.isFinite && r.frame.origin.y.isFinite)
    }

    // MARK: invariant sweep

    /// For every display, with the item at every x across (and beyond) it, the panel is inside the
    /// chosen display's visible frame, below the notch band, and never wider than allowed.
    @Test func sweepKeepsThePanelInsideTheVisibleFrame() {
        let rigs: [[ScreenGeometry]] = [
            [Rig.notchedLaptop],
            [Rig.notchedLaptop, Rig.externalRight],
            [Rig.notchedLaptop, Rig.leftOfPrimary, Rig.externalRight, Rig.above],
        ]
        for screens in rigs {
            for screen in screens {
                for x in stride(from: screen.frame.minX - 100, through: screen.frame.maxX + 100, by: 23) {
                    let item = Rig.item(on: screen, x: x)
                    let r = PanelPlacement.place(statusItemFrame: item, panelSize: Rig.panel, screens: screens)
                    let chosen = screens[r.screenIndex ?? 0]
                    #expect(r.frame.minX >= chosen.visibleFrame.minX + 8 - 0.001)
                    #expect(r.frame.maxX <= chosen.visibleFrame.maxX - 8 + 0.001)
                    #expect(r.frame.maxY <= chosen.visibleFrame.maxY + 0.001)
                    #expect(r.frame.maxY <= chosen.frame.maxY - chosen.topSafeAreaInset + 0.001)
                    #expect(r.frame.minY >= chosen.visibleFrame.minY - 0.001, "x=\(x) frame=\(r.frame)")
                    if r.frame.height == Rig.panel.height {
                        #expect(r.frame.minY >= chosen.visibleFrame.minY + 8 - 0.001)   // margin kept when not shrunk
                    }
                    #expect(r.anchorX >= 0 && r.anchorX <= r.frame.width)
                }
            }
        }
    }

    @Test func matchesTheOriginalSpikeBehaviourOnASingleDisplay() {
        // Regression anchor: the spike's pure function, same numbers.
        let screen = ScreenGeometry(frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                                    visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 944))
        let item = CGRect(x: 900, y: 944, width: 30, height: 38)
        let f = PanelPlacement.frame(statusItemFrame: item, panelSize: CGSize(width: 340, height: 420), screens: [screen])
        #expect(f.midX == item.midX)
        #expect(f.maxY == 938)
    }
}
