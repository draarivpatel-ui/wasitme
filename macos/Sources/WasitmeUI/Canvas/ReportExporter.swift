import AppKit
import WasitmeCore

/// Where the evidence report's Markdown comes from. The engine owns every word of it (D59), so the app never writes
/// one itself; the canvas's Report page previews the same report.
public protocol ReportMarkdownSource: Sendable {
    func markdown(agentID: String?) async throws -> String
}

public enum ReportExportError: Error, Equatable, Sendable {
    /// The engine produced no usable report (not installed, no `report` command yet, failed, or empty output).
    case unavailable(String)
    /// The temp file could not be written.
    case writeFailed
    /// Refused to open anything but our own temp `.md` file.
    case refusedToOpen
    case openFailed

    /// Plain words for the native alert. No engine text, no paths.
    public var message: String {
        switch self {
        case .unavailable(let why): "The evidence report isn't available: \(why). Nothing was copied or opened."
        case .writeFailed: "The report couldn't be saved to a temporary file. Nothing was opened."
        case .refusedToOpen, .openFailed: "The report couldn't be opened."
        }
    }
}

/// The report from the engine's `report` action.
///
/// `node <cli> report --md [--agent ID] --json` (the runner appends `--json`) prints
/// `{"schema":"wasitme.report/1","format":"md","markdown":"…"}`; `markdown` is the report text (WP-30,
/// engine/src/cli/commands/show.ts). A failure is shown as such, never replaced by an invented report.
public struct EngineReportSource: ReportMarkdownSource {
    let runner: EngineRunner

    public init(runner: EngineRunner) { self.runner = runner }

    public func markdown(agentID: String?) async throws -> String {
        var args = ["--md"]
        if let agentID { args += ["--agent", agentID] }
        let out: EngineOutput
        do { out = try await runner.run(.report, arguments: args) } catch let e as EngineError {
            switch e {
            case .notConfigured: throw ReportExportError.unavailable("wasitme's engine isn't set up")
            default: throw ReportExportError.unavailable("the engine's report command failed")
            }
        }
        guard let object = try? JSONSerialization.jsonObject(with: out.stdout) as? [String: Any],
              let md = object["markdown"] as? String, !md.isEmpty else {
            throw ReportExportError.unavailable("the engine returned no report")
        }
        return md
    }
}

/// "Copy evidence report" and "Open as Markdown" (bridge actions; D44(5e)). Never a network URL: the only thing
/// it ever opens is a `.md` file it just wrote, owner-only, under the app's temporary directory.
@MainActor
public final class ReportExporter {
    let source: any ReportMarkdownSource
    let pasteboard: NSPasteboard
    let directory: URL
    let openFile: @MainActor (URL) -> Bool
    let now: () -> Date

    public static let maxBytes = 2 << 20

    public init(source: any ReportMarkdownSource, pasteboard: NSPasteboard = .general,
                directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("wasitme-reports", isDirectory: true),
                openFile: @escaping @MainActor (URL) -> Bool = { NSWorkspace.shared.open($0) },
                now: @escaping () -> Date = { Date() }) {
        self.source = source; self.pasteboard = pasteboard; self.directory = directory; self.openFile = openFile; self.now = now
    }

    /// Puts the report on the pasteboard as plain text.
    public func copy(agentID: String?) async -> Result<Void, ReportExportError> {
        switch await fetch(agentID) {
        case .failure(let e): return .failure(e)
        case .success(let md):
            pasteboard.clearContents()
            pasteboard.setString(md, forType: .string)
            return .success(())
        }
    }

    /// Writes the report to `<tmp>/wasitme-reports/wasitme-report-….md` (0600) and opens it in the default app for it.
    public func openMarkdown(agentID: String?) async -> Result<URL, ReportExportError> {
        let md: String
        switch await fetch(agentID) {
        case .failure(let e): return .failure(e)
        case .success(let text): md = text
        }
        guard let url = write(md, agentID: agentID) else { return .failure(.writeFailed) }
        guard Self.isOwnReportFile(url, in: directory) else { return .failure(.refusedToOpen) }
        return openFile(url) ? .success(url) : .failure(.openFailed)
    }

    private func fetch(_ agentID: String?) async -> Result<String, ReportExportError> {
        do {
            return .success(Self.clean(try await source.markdown(agentID: agentID)))
        } catch let e as ReportExportError {
            return .failure(e)
        } catch {
            return .failure(.unavailable("the engine's report command failed"))
        }
    }

    func write(_ md: String, agentID: String?) -> URL? {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let stamp = ContractDate.format(now()).prefix(19).replacingOccurrences(of: ":", with: "")
            let who = agentID.map { TextSanitizer.clean($0, maxCharacters: 32).filter { $0.isLetter || $0.isNumber || $0 == "-" } } ?? ""
            let name = ["wasitme-report", who.isEmpty ? nil : who, stamp].compactMap { $0 }.joined(separator: "-") + ".md"
            let url = directory.appendingPathComponent(name, isDirectory: false)
            guard fm.createFile(atPath: url.path, contents: Data(md.utf8), attributes: [.posixPermissions: 0o600]) else { return nil }
            return url
        } catch {
            return nil
        }
    }

    /// Only a regular `.md` file directly inside our directory, by file URL.
    static func isOwnReportFile(_ url: URL, in directory: URL) -> Bool {
        guard url.isFileURL, url.pathExtension == "md" else { return false }
        let dir = directory.resolvingSymlinksInPath().standardizedFileURL.path
        let file = url.resolvingSymlinksInPath().standardizedFileURL
        guard file.deletingLastPathComponent().path == dir else { return false }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir) && !isDir.boolValue
    }

    /// Bounded, and free of control, bidi and escape characters other than newlines and tabs.
    static func clean(_ md: String) -> String {
        var out = String.UnicodeScalarView()
        var bytes = 0
        for s in md.unicodeScalars {
            let v = s.value
            let control = (v < 0x20 && s != "\n" && s != "\t") || (0x7F...0x9F).contains(v)
            let bidi = (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0x200E || v == 0x200F
            if control || bidi { continue }
            bytes += String(s).utf8.count
            if bytes > maxBytes { break }
            out.append(s)
        }
        return String(out)
    }
}
