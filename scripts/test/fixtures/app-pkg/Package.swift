// swift-tools-version:5.9
// Tiny stand-in for macos/: just enough to exercise the installer's build -> bundle -> codesign path.
// Foundation only (no SwiftUI), so it builds with Command Line Tools in seconds.
import PackageDescription

let package = Package(
    name: "wasitme-test-app",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "WasitmeApp",
            resources: [.copy("hello.txt")]
        )
    ]
)
