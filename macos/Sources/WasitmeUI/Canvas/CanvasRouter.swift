import Foundation

/// Where the canvas files come from.
public enum CanvasAssetSource: Sendable, Equatable {
    /// The compiled-in placeholder page (until WP-41 ships `ui/dist`).
    case embeddedPlaceholder
    /// A directory holding `app.html`, `app.js`, `app.css`, `fonts/` (the real canvas).
    case directory(URL)

    /// `--canvas DIR` wins; then `<App>.app/Contents/Resources/ui/` when it holds an `app.html`
    /// (WP-51's build-app.sh copies `ui/dist` there); otherwise the embedded placeholder.
    public static func resolve(override: URL?, bundleResources: URL? = Bundle.main.resourceURL) -> CanvasAssetSource {
        if let override { return .directory(override.standardizedFileURL) }
        if let res = bundleResources?.appendingPathComponent("ui", isDirectory: true),
           FileManager.default.fileExists(atPath: res.appendingPathComponent("app.html").path) {
            return .directory(res.standardizedFileURL)
        }
        return .embeddedPlaceholder
    }

    public var isPlaceholder: Bool { self == .embeddedPlaceholder }
}

public struct CanvasResponse: Equatable, Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data
}

/// The `wasitme-app://` scheme handler's decisions, as a pure function (tested without WebKit).
///
/// Serves only `wasitme-app://canvas/<path>` for GET, only plain file names with an allow-listed
/// extension, never anything outside the asset root (no `..`, no hidden files, no symlink escapes), and
/// puts the strict Content-Security-Policy on every response (D48). The CSP arrives as a
/// response header (verified: WebKit enforces it for custom-scheme responses; an inline script is
/// blocked), so the page needs no `<meta>` CSP of its own.
public enum CanvasRouter {
    public static let scheme = "wasitme-app"
    public static let host = "canvas"
    public static let entryURL = URL(string: "wasitme-app://canvas/app.html")!

    /// The canvas policy (D48) plus `base-uri` and `form-action`, which do not fall back to `default-src`.
    public static let contentSecurityPolicy =
        "default-src 'none'; script-src wasitme-app:; style-src wasitme-app:; font-src wasitme-app:; " +
        "img-src wasitme-app: data:; base-uri 'none'; form-action 'none'"

    public static let maxFileBytes = 16 << 20

    static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "woff2": "font/woff2",
        "svg": "image/svg+xml",
        "png": "image/png",
        "txt": "text/plain; charset=utf-8",
    ]

    static func baseHeaders(contentType: String, length: Int) -> [String: String] {
        [
            "Content-Type": contentType,
            "Content-Length": String(length),
            "Content-Security-Policy": contentSecurityPolicy,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        ]
    }

    static func notFound() -> CanvasResponse {
        let body = Data("not found".utf8)
        return CanvasResponse(status: 404, headers: baseHeaders(contentType: "text/plain; charset=utf-8", length: body.count), body: body)
    }

    /// The validated path components of a canvas URL, or nil.
    public static func components(of url: URL, method: String?) -> [String]? {
        guard method == nil || method == "GET" else { return nil }
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == host,
              url.user == nil, url.password == nil, url.port == nil else { return nil }
        let raw = url.path(percentEncoded: false)
        guard raw.hasPrefix("/"), !raw.contains("\\"), !raw.contains("\0") else { return nil }
        let parts = raw.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard !parts.isEmpty, parts.count <= 4 else { return nil }
        for p in parts {
            guard !p.isEmpty, !p.hasPrefix("."), p.count <= 64,
                  p.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_") })
            else { return nil }
        }
        guard let ext = parts.last?.split(separator: ".").last.map({ String($0).lowercased() }),
              mimeTypes[ext] != nil else { return nil }
        return parts
    }

    public static func respond(to url: URL, method: String?, assets: CanvasAssetSource) -> CanvasResponse {
        guard let parts = components(of: url, method: method),
              let ext = parts.last?.split(separator: ".").last.map({ String($0).lowercased() }),
              let mime = mimeTypes[ext] else { return notFound() }
        let body: Data
        switch assets {
        case .embeddedPlaceholder:
            guard parts.count == 1, let text = PlaceholderCanvas.files[parts[0]] else { return notFound() }
            body = Data(text.utf8)
        case .directory(let root):
            guard let data = readContained(root: root, parts: parts) else { return notFound() }
            body = data
        }
        return CanvasResponse(status: 200, headers: baseHeaders(contentType: mime, length: body.count), body: body)
    }

    /// Reads `root/parts...` only if, after resolving symlinks, it is a regular file inside `root`.
    static func readContained(root: URL, parts: [String]) -> Data? {
        let realRoot = root.resolvingSymlinksInPath().standardizedFileURL.path
        var target = root
        for p in parts { target.appendPathComponent(p, isDirectory: false) }
        let realTarget = target.resolvingSymlinksInPath().standardizedFileURL.path
        guard realTarget.hasPrefix(realRoot.hasSuffix("/") ? realRoot : realRoot + "/") else { return nil }
        var st = stat()
        guard stat(realTarget, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= off_t(maxFileBytes) else { return nil }
        return FileManager.default.contents(atPath: realTarget)
    }
}

/// Which navigations the canvas web view may perform: only its own scheme and host, in the main frame or
/// a same-origin subframe. Everything else (links, `window.location`, form posts, new windows) is denied.
public enum CanvasNavigationPolicy {
    public static func allows(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == CanvasRouter.scheme && url.host?.lowercased() == CanvasRouter.host
            && CanvasRouter.components(of: url, method: nil) != nil
    }
}
