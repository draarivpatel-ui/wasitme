import AppKit
import CoreText

/// Registers the bundled IBM Plex faces (D57; SIL OFL 1.1, `fonts/OFL.txt` ships next to them) for this process only.
///
/// Where the files are: `<App>.app/Contents/Resources/fonts/` (build-app.sh copies design/system/fonts/app there), or,
/// for an unbundled binary (`swift run`, `swift test`, `--capture` from .build), `design/system/fonts/app` found by
/// walking up from the executable and the working directory. `SwiftUI.Font.custom` falls back to the system font
/// SILENTLY when a face is missing, so capture and the tests check `isRegistered` instead of trusting this.
public enum FontRegistry {
    /// The six upstream files (design/system/fonts/app).
    public static let files = [
        "IBMPlexSerif-Regular.ttf", "IBMPlexSerif-Italic.ttf", "IBMPlexSerif-Bold.ttf", "IBMPlexSerif-BoldItalic.ttf",
        "IBMPlexMono-Regular.ttf", "IBMPlexMono-Bold.ttf",
    ]

    /// PostScript names the type scale uses (Tokens.TypeScale), all of which must resolve after registration.
    public static let postScriptNames = files.map { String($0.dropLast(4)) }

    public struct Outcome: Sendable, Equatable {
        public var directory: String?
        public var registered: Int
        public var failed: [String]
    }

    private static let state = Lockbox()

    /// Idempotent: the first call registers, later calls return the first outcome.
    @discardableResult
    public static func registerBundledFonts(directory override: URL? = nil) -> Outcome {
        state.once {
            guard let dir = override ?? locate() else { return Outcome(directory: nil, registered: 0, failed: files) }
            var registered = 0
            var failed: [String] = []
            for name in files {
                let url = dir.appendingPathComponent(name)
                var error: Unmanaged<CFError>?
                if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                    registered += 1
                } else if let e = error?.takeRetainedValue(),
                          CFErrorGetCode(e) == CTFontManagerError.alreadyRegistered.rawValue {
                    registered += 1
                } else {
                    failed.append(name)
                }
            }
            return Outcome(directory: dir.lastPathComponent, registered: registered, failed: failed)
        }
    }

    /// True when every face the type scale names resolves to the bundled font.
    public static var isRegistered: Bool {
        postScriptNames.allSatisfy { NSFont(name: $0, size: 12)?.fontName == $0 }
    }

    /// `Contents/Resources/fonts`, else `design/system/fonts/app` above the executable or the working directory.
    static func locate() -> URL? {
        let fm = FileManager.default
        func has(_ dir: URL) -> Bool { fm.fileExists(atPath: dir.appendingPathComponent(files[0]).path) }
        if let res = Bundle.main.resourceURL?.appendingPathComponent("fonts", isDirectory: true), has(res) { return res }
        var starts = [URL(fileURLWithPath: fm.currentDirectoryPath, isDirectory: true)]
        if let exe = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent() { starts.append(exe) }
        for start in starts {
            var dir = start.standardizedFileURL
            for _ in 0..<10 {
                let candidate = dir.appendingPathComponent("design/system/fonts/app", isDirectory: true)
                if has(candidate) { return candidate }
                let parent = dir.deletingLastPathComponent()
                if parent.path == dir.path { break }
                dir = parent
            }
        }
        return nil
    }

    /// A once-only cell (registration is process-wide, so it must not race between test suites).
    private final class Lockbox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Outcome?
        func once(_ make: () -> Outcome) -> Outcome {
            lock.lock(); defer { lock.unlock() }
            if let value { return value }
            let v = make()
            value = v
            return v
        }
    }
}
