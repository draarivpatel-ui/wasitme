// swift-tools-version:6.0
// Tools-version 6.0 => Swift 6 language mode (complete concurrency checking) by default.
import Foundation
import PackageDescription

// The tests are declared only where their sources are. The release tarball ships macos/ without Tests/
// (scripts/release.sh's allow-list), and SwiftPM refuses a package that declares a test target whose
// folder is missing, so the installer's `swift build` of a release would fail without this.
let testTargets: [Target] = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests") ? [
    .testTarget(name: "WasitmeCoreTests", dependencies: ["WasitmeCore"]),
    .testTarget(name: "WasitmeUITests", dependencies: ["WasitmeUI", "WasitmeCore"]),
] : []

let package = Package(
    name: "Wasitme",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "WasitmeCore", targets: ["WasitmeCore"]),
        .library(name: "WasitmeUI", targets: ["WasitmeUI"]),
        .executable(name: "WasitmeApp", targets: ["WasitmeApp"]),
    ],
    targets: [
        // Pure, testable plumbing: contract models, display rules, file store, engine runner, panel
        // placement, LaunchAgent plist, launch-at-login interface. Foundation + CoreGraphics + Observation
        // only. Zero third-party dependencies, no AppKit/SwiftUI, no network APIs.
        .target(name: "WasitmeCore"),
        // The app shell: status item, popover panel, desktop panel, Control Center (native chrome around a
        // locked-down WKWebView), offscreen capture. AppKit + SwiftUI + WebKit. Every colour, font, size
        // and glyph goes through `Theme` (Theme/Theme.swift), the one file the brand tokens replace.
        .target(name: "WasitmeUI", dependencies: ["WasitmeCore"]),
        // Thin entry point: option parsing, the headless self-check, then WasitmeUI.
        .executableTarget(name: "WasitmeApp", dependencies: ["WasitmeCore", "WasitmeUI"]),
    ] + testTargets
)
