import AppKit
import Foundation
import SwiftUI
import Testing
@testable import WasitmeCore
@testable import WasitmeUI

@Suite struct SingleInstanceTests {
    @Test func decision() {
        #expect(SingleInstance.decide(lockAcquired: true, otherInstancePIDs: []) == .proceed)
        #expect(SingleInstance.decide(lockAcquired: false, otherInstancePIDs: []) == .handOff)
        #expect(SingleInstance.decide(lockAcquired: true, otherInstancePIDs: [123]) == .handOff)
    }

    @Test func lockFileIsPerBundleAndHomeAndStaysInTemp() throws {
        let tmp = try TempDir("lockname")
        let a = SingleInstance.lockURL(bundleID: "dev.wasitme.app", home: URL(fileURLWithPath: "/tmp/a"), tempDirectory: tmp.url)
        let a2 = SingleInstance.lockURL(bundleID: "dev.wasitme.app", home: URL(fileURLWithPath: "/tmp/a/"), tempDirectory: tmp.url)
        let b = SingleInstance.lockURL(bundleID: "dev.wasitme.app", home: URL(fileURLWithPath: "/tmp/b"), tempDirectory: tmp.url)
        #expect(a == a2 && a != b)
        #expect(a.deletingLastPathComponent().standardizedFileURL == tmp.url.standardizedFileURL)
        #expect(a.lastPathComponent.hasPrefix("wasitme-") && a.pathExtension == "lock")
    }

    /// flock locks belong to an open file description: a second open in the same process is refused too,
    /// exactly as a second process would be.
    @Test func theLockIsExclusiveUntilReleased() throws {
        let tmp = try TempDir("lock")
        let url = tmp.url.appendingPathComponent("x.lock")
        var first: InstanceLock? = InstanceLock(url: url)
        #expect(first != nil)
        #expect(InstanceLock(url: url) == nil, "a second instance must not get the lock")
        first = nil
        #expect(InstanceLock(url: url) != nil, "released when the holder goes away")
        _ = first
    }

    /// Only another copy of THIS bundle (same location) counts as "already running". A different bundle that shares the
    /// bundle id (a dist build with a temp --home next to the installed app) must not hand off to, or make the real app
    /// exit for, a test instance: the per-home lock decides for it.
    @Test func onlyACopyOfTheSameBundleCounts() {
        let real = URL(fileURLWithPath: "/Applications/wasitme.app", isDirectory: true)
        let dist = URL(fileURLWithPath: "/work/macos/dist/WasitmeApp.app", isDirectory: true)
        let running: [(pid: pid_t, bundleURL: URL?)] = [(100, real), (200, dist), (300, nil), (400, real), (0, real)]
        #expect(SingleInstance.sameBundle(running, as: real, selfPID: 400) == [100], "the dist copy and the unknown one are ignored")
        #expect(SingleInstance.sameBundle(running, as: dist, selfPID: 999) == [200])
        #expect(SingleInstance.sameBundle(running, as: nil, selfPID: 999).isEmpty)
        let sameButSpelledOddly = URL(fileURLWithPath: "/Applications/./wasitme.app/", isDirectory: true)
        #expect(SingleInstance.sameBundle([(100, sameButSpelledOddly)], as: real, selfPID: 1) == [100])
    }

    @Test @MainActor func anUnbundledBinaryHasNoOtherInstancesByBundleID() {
        #expect(SingleInstance.otherInstances(bundleID: nil).isEmpty)
    }
}

@Suite @MainActor struct StatusItemPresenterTests {
    /// Every glyph state has a VoiceOver label and tooltip equal to its state text.
    @Test func voiceOverLabelEqualsTooltipForEveryGolden() throws {
        _ = Headless.ready
        #expect(Repo.manifest.count >= 30)
        for entry in Repo.manifest {
            let d = try #require(Repo.display(entry))
            let button = NSButton(frame: .zero)
            StatusItemPresenter.apply(d, to: button)
            #expect(button.toolTip == d.accessibilityLabel, "\(entry.file)")
            #expect(button.accessibilityLabel() == d.accessibilityLabel, "\(entry.file)")
            #expect(button.image?.isTemplate == true && button.image?.accessibilityDescription == d.accessibilityLabel, "\(entry.file)")
            let wantAlpha: Double = d.glyphDimmed ? Double(Theme.current.metrics.menuBarDimmedAlpha) : 1
            #expect(abs(Double(button.alphaValue) - wantAlpha) < 0.01, "\(entry.file): alpha \(button.alphaValue), want \(wantAlpha)")
            #expect(d.accessibilityLabel.contains(d.stateText), "\(entry.file): the label carries the state text")
            // DESIGN.md §6: "+n" beside the glyph, only on a current document.
            #expect(button.title == (d.newEventCount > 0 ? "+\(d.newEventCount)" : ""), "\(entry.file): title \(button.title)")
            #expect(button.imagePosition == (d.newEventCount > 0 ? .imageLeading : .imageOnly), "\(entry.file)")
        }
        #expect(Repo.manifest.contains { Repo.display($0)?.newEventCount ?? 0 > 0 }, "some golden has a new change")
    }

    @Test func statusBarButtonDimsTheSystemWay() {
        _ = Headless.ready
        let d = GlanceDisplay.make(status: .invalid("x"), glance: nil, now: Date())
        let button = NSStatusBarButton(frame: .zero)
        StatusItemPresenter.apply(d, to: button)
        #expect(button.appearsDisabled == d.glyphDimmed)
    }
}

@Suite @MainActor struct OffscreenRenderTests {
    func isBlank(_ png: Data) -> Bool {
        guard let rep = NSBitmapImageRep(data: png) else { return true }
        let first = rep.colorAt(x: 0, y: 0)
        for y in stride(from: 0, to: rep.pixelsHigh, by: 7) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 7) where rep.colorAt(x: x, y: y) != first { return false }
        }
        return true
    }

    /// Every glance golden renders every native surface offscreen, in both appearances, with no window.
    @Test func everyGlanceGoldenRendersEverySurface() throws {
        _ = Headless.ready
        let windowsBefore = NSApp.windows.filter(\.isVisible).count
        for entry in Repo.manifest where entry.contract == "glance" {
            let d = try #require(Repo.display(entry))
            for dark in [false, true] {
                let pop = try #require(Offscreen.png(PopoverView(display: d, actions: .inert), size: Theme.current.metrics.popover, dark: dark))
                let rep = try #require(NSBitmapImageRep(data: pop))
                #expect(rep.pixelsWide >= Int(Theme.current.metrics.popover.width), "\(entry.file)")
                #expect(!isBlank(pop), "\(entry.file): popover is blank")
                for size in DesktopPanelSize.allCases {
                    let png = try #require(Offscreen.png(DesktopPanelView(display: d, size: size), size: size.size, dark: dark))
                    #expect(!isBlank(png), "\(entry.file): \(size) panel is blank")
                }
            }
        }
        #expect(NSApp.windows.filter(\.isVisible).count == windowsBefore, "rendering must never show a window")
    }

    @Test func lightAndDarkDiffer() throws {
        _ = Headless.ready
        let entry = try #require(Repo.manifest.first { $0.file == "glance/you-verdict.json" })
        let d = try #require(Repo.display(entry))
        let light = Offscreen.png(DesktopPanelView(display: d, size: .small), size: DesktopPanelSize.small.size, dark: false)
        let dark = Offscreen.png(DesktopPanelView(display: d, size: .small), size: DesktopPanelSize.small.size, dark: true)
        #expect(light != nil && light != dark)
    }

    /// D28/D61: timeline-led (the default) lands on Timeline, verdict-led on Finding. The canvas column holds the canvas
    /// alone (the window's sidebar and toolbar are native: ControlCenterWindowTests).
    @Test func controlCenterLandsByLeadAndTheCanvasColumnIsAllCanvas() throws {
        _ = Headless.ready
        for (file, page) in [("glance/you-verdict.json", ControlCenterPage.verdict), ("glance/you-timeline.json", .timeline)] {
            let entry = try #require(Repo.manifest.first { $0.file == file })
            let model = ControlCenterModel(display: try #require(Repo.display(entry)), snapshot: nil)
            #expect(model.page == page, "\(file): D28 landing page")
        }
        #expect(ControlCenterPage.verdict.title == "Finding", "D57: the UI says Finding")
        #expect(!ControlCenterPage.allCases.contains { $0.title.contains("Verdict") })
        let content = ControlCenterContentView(size: Theme.current.metrics.controlCenter)
        content.layoutSubtreeIfNeeded()
        #expect(content.subviews.count == 1 && content.canvas.frame == content.bounds)
        let png = try #require(Offscreen.composite(content, web: nil, webFrame: content.canvas.frame))
        #expect(!isBlank(png))
        #expect(Glance().lead == .timeline && Snapshot().lead == .timeline, "D61: the default lead is timeline")
    }
}

@Suite @MainActor struct KeyboardTests {
    /// Escape (cancelOperation) closes the popover panel.
    @Test func escapeClosesThePopoverPanel() {
        _ = Headless.ready
        let panel = StatusPanel(size: Theme.current.metrics.popover)
        var closed = false
        panel.onCancel = { closed = true }
        panel.cancelOperation(nil)
        #expect(closed)
        #expect(panel.canBecomeKey && !panel.canBecomeMain)
        #expect(!panel.isVisible)
    }

    @Test func desktopPanelSitsJustAboveTheDesktopIconsAndNeverTakesFocus() {
        _ = Headless.ready
        let panel = DesktopPanel(size: Theme.current.metrics.panelSmall)
        #expect(panel.level.rawValue == Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        #expect(!panel.canBecomeKey && !panel.canBecomeMain)
        #expect(panel.collectionBehavior.contains(.canJoinAllSpaces) && panel.collectionBehavior.contains(.stationary))
    }
}

@Suite struct LaunchOptionsTests {
    @Test func parsesTheShellFlags() {
        let o = LaunchOptions.parse(["WasitmeApp", "--capture", "/tmp/cap", "--fixtures", "/tmp/fx", "--canvas", "/tmp/ui",
                                     "--memory-report", "/tmp/m.json", "--memory-report-after", "12", "--unknown", "--home", "/tmp/h"])
        #expect(o.captureDirectory?.path == "/tmp/cap" && o.fixturesDirectory?.path == "/tmp/fx" && o.canvasDirectory?.path == "/tmp/ui")
        #expect(o.memoryReportFile?.path == "/tmp/m.json" && o.memoryReportAfter == 12)
        #expect(o.home.url.path == "/tmp/h")
        #expect(LaunchOptions.parse(["WasitmeApp", "--memory-report-after", "-5"]).memoryReportAfter == 30)
        #expect(LaunchOptions.parse(["WasitmeApp"]).captureDirectory == nil)
    }

    /// Nothing but the user's own click shows the Control Center: no launch flag puts it on the screen (QA draws it
    /// offscreen with `--capture`), and nothing orders it in behind other windows.
    @Test func noFlagPutsTheWindowOnScreen() throws {
        let o = LaunchOptions.parse(["WasitmeApp", "--open-control-center", "settings", "--appearance", "dark"])
        #expect(o.captureDirectory == nil && !o.selfCheck, "unknown flags are ignored")
        let source = try String(contentsOf: Repo.uiSources.appendingPathComponent("App/ControlCenterController.swift"), encoding: .utf8)
        #expect(!source.contains("orderBack") && !source.contains("orderFrontRegardless"))
        #expect(source.components(separatedBy: "makeKeyAndOrderFront").count == 2, "one place shows the window: show(page:)")
    }
}

@Suite struct MemoryProbeTests {
    @Test func measuresThisProcess() throws {
        let fp = try #require(MemoryProbe.selfFootprint())
        #expect(fp > 1 << 20 && fp < 8 << 30)
        let r = MemoryProbe.report(label: "test", since: MemoryProbe.baseline())
        #expect(r.appFootprintBytes > 0 && r.appPlusWebContentBytes >= r.appFootprintBytes)
        #expect(MemoryProbe.footprint(pid: -1) == nil)
    }

    /// D48 budgets are RSS: the probe must report it (it reported only the footprint before), and RSS includes the
    /// shared framework pages the footprint leaves out.
    @Test func reportsResidentSetSizeNextToTheFootprint() throws {
        let rss = try #require(MemoryProbe.selfResident())
        #expect(rss > 1 << 20 && rss < 8 << 30)
        let r = MemoryProbe.report(label: "test", since: nil)
        #expect(r.appResidentBytes > 0 && r.appPlusWebContentResidentBytes == r.appResidentBytes)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as? [String: Any]
        for key in ["appResidentBytes", "appResidentMiB", "appPlusWebContentResidentBytes", "appPlusWebContentResidentMiB", "appFootprintBytes"] {
            #expect(json?[key] != nil, "\(key) in the report file")
        }
        #expect(r.summary.contains("MiB RSS"))
    }

    @Test func budgetsAreTheD48Numbers() throws {
        #expect(MemoryBudget.idleResident == 60 * 1_048_576)
        #expect(MemoryBudget.controlCenterResident == 180_000_000)
        let mib: UInt64 = 1_048_576
        func report(app: UInt64, web: UInt64) -> MemoryProbe.Report {
            let json = #"{"label":"t","appFootprintBytes":1,"appResidentBytes":\#(app),"helpers":[{"pid":7,"kind":"WebContent","footprintBytes":1,"residentBytes":\#(web)},{"pid":8,"kind":"GPU","footprintBytes":1,"residentBytes":\#(500 * mib)}]}"#
            return try! JSONDecoder().decode(MemoryProbe.Report.self, from: Data(json.utf8))
        }
        #expect(MemoryBudget.idle(report(app: 59 * mib, web: 0)).within)
        #expect(!MemoryBudget.idle(report(app: 61 * mib, web: 0)).within)
        #expect(MemoryBudget.controlCenter(report(app: 60 * mib, web: 100 * mib)).within, "160 MiB < 180 MB; the GPU helper is not counted")
        #expect(!MemoryBudget.controlCenter(report(app: 80 * mib, web: 100 * mib)).within, "180 MiB > 180 MB")
        #expect(!MemoryBudget.idle(report(app: 0, web: 0)).within, "a failed measurement is never a pass")
        #expect(MemoryBudget.idle(report(app: 61 * mib, web: 0)).line.hasSuffix("OVER"))
    }

    @Test func olderReportFilesWithoutRSSStillDecode() throws {
        let json = #"{"label":"old","appFootprintBytes":5,"helpers":[{"pid":1,"kind":"WebContent","footprintBytes":2}]}"#
        let r = try JSONDecoder().decode(MemoryProbe.Report.self, from: Data(json.utf8))
        #expect(r.appResidentBytes == 0 && r.helpers.first?.residentBytes == 0 && r.appPlusWebContentBytes == 7)
    }
}

/// The app builds with Command Line Tools alone: no SwiftUI macro may be used (macos/README.md). The banned
/// list is read from the installed SDK's SwiftUI/SwiftUICore interfaces when present, plus a fixed floor.
@Suite struct MacroBanTests {
    static func sdkMacros() -> Set<String> {
        var names: Set<String> = ["State", "Entry", "Preview", "Previewable", "Animatable", "AnimatableIgnored"]
        let base = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks"
        for fw in ["SwiftUI", "SwiftUICore"] {
            let path = "\(base)/\(fw).framework/Modules/\(fw).swiftmodule/arm64e-apple-macos.swiftinterface"
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            for m in text.matches(of: /public macro ([A-Z][A-Za-z]*)/) { names.insert(String(m.1)) }
        }
        return names
    }

    @Test func noSwiftUIMacrosInTheApp() throws {
        let macros = Self.sdkMacros()
        #expect(macros.contains("State"))
        for file in Repo.swiftFiles(under: Repo.allSources) {
            let text = try String(contentsOf: file, encoding: .utf8)
            for name in macros {
                let pattern = try Regex("(^|[^A-Za-z0-9_])[@#]\(name)\\b")
                for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                    #expect(line.firstMatch(of: pattern) == nil, "\(file.lastPathComponent): @\(name) is a macro: \(line)")
                }
            }
        }
    }
}
