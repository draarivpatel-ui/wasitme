import AppKit
import Foundation
@testable import WasitmeCore
@testable import WasitmeUI

/// Paths found from this file's location: <repo>/macos/Tests/WasitmeUITests/Support.swift.
enum Repo {
    static let macos = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let root = macos.deletingLastPathComponent()
    static let fixtures = root.appendingPathComponent("contract/fixtures", isDirectory: true)
    static let uiSources = macos.appendingPathComponent("Sources/WasitmeUI", isDirectory: true)
    static let allSources = macos.appendingPathComponent("Sources", isDirectory: true)

    static func swiftFiles(under dir: URL) -> [URL] {
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        return (e?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }.sorted { $0.path < $1.path }
    }

    struct Entry: Decodable { let file: String; let contract: String; let valid: Bool; let now: String }
    struct Manifest: Decodable { let fixtures: [Entry] }

    static let manifest: [Entry] = {
        guard let data = try? Data(contentsOf: fixtures.appendingPathComponent("manifest.json")),
              let m = try? JSONDecoder().decode(Manifest.self, from: data) else { return [] }
        return m.fixtures
    }()

    /// The display every surface renders for a golden, at the manifest's `now`.
    static func display(_ entry: Entry) -> GlanceDisplay? {
        guard let data = try? Data(contentsOf: fixtures.appendingPathComponent(entry.file)),
              let now = ContractDate.parse(entry.now) else { return nil }
        if entry.contract == "glance" {
            let (s, g) = ContractFile.readGlance(data)
            return GlanceDisplay.make(status: s, glance: g, now: now)
        }
        let (s, snap) = ContractFile.readSnapshot(data)
        return GlanceDisplay.make(status: s, glance: snap?.glancePart, now: now)
    }
}

/// A throwaway directory under the system temp dir (never ~/.wasitme, ~/Library, ~/.claude, ~/.codex).
final class TempDir: @unchecked Sendable {
    let url: URL
    init(_ label: String) throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wasitme-uitest-\(label)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(at: url) }
}

/// AppKit without any UI: no Dock icon, no menu bar, no activation for the test process.
@MainActor
enum Headless {
    static let ready: Void = {
        NSApplication.shared.setActivationPolicy(.prohibited)
        FontRegistry.registerBundledFonts(directory: Repo.root.appendingPathComponent("design/system/fonts/app", isDirectory: true))
    }()
}
