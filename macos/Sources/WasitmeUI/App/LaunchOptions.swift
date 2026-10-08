import Foundation
import WasitmeCore

/// Command-line options. Unknown flags are ignored (launchd may add its own).
///
///     WasitmeApp [--home DIR] [--supervised] [--canvas DIR] [--memory-report FILE --memory-report-after SEC]
///     WasitmeApp --self-check [--home DIR] [--engine ACTION]    (headless: no windows, no AppKit)
///     WasitmeApp --capture DIR [--fixtures DIR] [--canvas DIR]  (offscreen PNGs: no window, no status item)
///
/// No flag opens the Control Center for a screenshot: a window or a menu bar icon appearing on the screen of someone using
/// the Mac is exactly what QA must not do. `--capture` draws the whole Control Center window (title bar, toolbar, sidebar,
/// page) offscreen instead, and never orders it in.
public struct LaunchOptions: Sendable {
    /// Directory the engine writes to; default `~/.wasitme`.
    public var home: WasitmeDirectory = .standard()
    /// Started by launchd with KeepAlive. Informational: a normal Quit exits 0 and stays quit.
    public var supervised = false
    /// Headless diagnostic: load the files, optionally run one allow-listed engine action, print, exit.
    public var selfCheck = false
    public var selfCheckEngineAction: String?
    /// Offscreen capture: render every view for every golden into this directory, then exit.
    public var captureDirectory: URL?
    /// `contract/fixtures` (default: found by walking up from the executable and the working directory).
    public var fixturesDirectory: URL?
    /// Serve the canvas from this directory instead of the bundle / embedded placeholder (WP-41 testing).
    public var canvasDirectory: URL?
    /// Measurement hook: after `memoryReportAfter` seconds, write a JSON memory report here.
    public var memoryReportFile: URL?
    public var memoryReportAfter: TimeInterval = 30

    public init() {}

    public static func parse(_ args: [String]) -> LaunchOptions {
        var o = LaunchOptions()
        var i = 1
        func next() -> String? { i += 1; return i < args.count ? args[i] : nil }
        func dir(_ path: String?) -> URL? { path.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL } }
        while i < args.count {
            switch args[i] {
            case "--home":
                if let path = next() { o.home = WasitmeDirectory(URL(fileURLWithPath: path, isDirectory: true)) }
            case "--supervised": o.supervised = true
            case "--self-check": o.selfCheck = true
            case "--engine": o.selfCheckEngineAction = next()
            case "--capture": o.captureDirectory = dir(next())
            case "--fixtures": o.fixturesDirectory = dir(next())
            case "--canvas": o.canvasDirectory = dir(next())
            case "--memory-report": o.memoryReportFile = next().map { URL(fileURLWithPath: $0).standardizedFileURL }
            case "--memory-report-after":
                if let s = next(), let v = TimeInterval(s), v.isFinite, v >= 0, v <= 86_400 { o.memoryReportAfter = v }
            default: break
            }
            i += 1
        }
        return o
    }
}
