import Foundation

/// Names that other code and files must agree on. Kept in one place so a rename (the brand is
/// not final) is a one-file change. Nothing here is a visual-design decision.
public enum WasitmeIdentity {
    /// Reverse-DNS bundle id for the app. PLACEHOLDER until the brand and domain are decided.
    public static let bundleIdentifier = "dev.wasitme.app"
    /// launchd label for the optional KeepAlive LaunchAgent (dogfooding path, D18).
    public static let launchAgentLabel = "dev.wasitme.menubar"
    /// Executable name inside the .app bundle.
    public static let executableName = "WasitmeApp"
    /// Command users run to update the engine (shown when the schema major does not match).
    public static let updateCommand = "wasitme update"
    /// Shown whenever a contract file has a schema major this app does not understand.
    public static let updateNeededMessage = "Update needed: run `\(updateCommand)`"
}

/// Where the engine and the app exchange files: `~/.wasitme` by default.
///
/// Files (all written atomically by the engine, read-only for the app):
///  - `glance.json`   small summary (<= 16 KB) for the menu bar and panel
///  - `snapshot.json` full analysis for the Control Center
///  - `engine.json`   how to run the engine: absolute paths of `node` and the CLI entry point
public struct WasitmeDirectory: Equatable, Sendable {
    public let url: URL

    public init(_ url: URL) {
        self.url = url.standardizedFileURL
    }

    /// `~/.wasitme` for the given home directory (injectable so tests never touch the real one).
    public static func standard(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> WasitmeDirectory {
        WasitmeDirectory(home.appendingPathComponent(".wasitme", isDirectory: true))
    }

    public var glanceURL: URL { url.appendingPathComponent("glance.json", isDirectory: false) }
    public var snapshotURL: URL { url.appendingPathComponent("snapshot.json", isDirectory: false) }
    public var engineConfigURL: URL { url.appendingPathComponent("engine.json", isDirectory: false) }
}
