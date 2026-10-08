import Foundation

/// The five engine commands the app may run. Nothing else is ever executed: the raw-string entry point
/// (`EngineAction(rawValue:)`) returns nil for anything not in this list.
public enum EngineAction: String, Sendable, CaseIterable, Hashable {
    case scan
    case report
    case compare
    case statusline
    case doctor
}

public enum EngineError: Error, Equatable, Sendable, CustomStringConvertible {
    /// `engine.json` does not exist: the engine has not been installed/registered yet.
    case notConfigured
    /// `engine.json` exists but cannot be used (unreadable, malformed, paths missing or not executable).
    case invalidConfig(String)
    /// An action or argument outside the allow-list.
    case invalidArgument(String)
    case launchFailed(String)
    case timedOut(seconds: Int)
    case outputTooLarge(limitBytes: Int)
    case cancelled
    case nonZeroExit(code: Int32, stderr: String)
    case killedBySignal(Int32, stderr: String)

    public var description: String {
        switch self {
        case .notConfigured: "The engine is not set up yet (no engine.json)."
        case .invalidConfig(let m): "engine.json is not usable: \(m)"
        case .invalidArgument(let m): "Refused to run: \(m)"
        case .launchFailed(let m): "Could not start the engine: \(m)"
        case .timedOut(let s): "The engine did not finish within \(s) s."
        case .outputTooLarge(let n): "The engine produced more than \(n / 1024 / 1024) MB of output."
        case .cancelled: "The engine run was cancelled."
        case .nonZeroExit(let c, let e): "The engine exited with code \(c)." + (e.isEmpty ? "" : " \(e)")
        case .killedBySignal(let s, _): "The engine was killed by signal \(s)."
        }
    }
}

/// How to run the engine: absolute paths of `node` and the CLI entry point, written by the installer
/// to `~/.wasitme/engine.json`:
///
///     { "schema": "wasitme.engine/1", "node": "/opt/homebrew/bin/node",
///       "cli": "/Users/me/.wasitme/current/engine/dist/src/cli/main.js", "version": "0.1.0",
///       "scanArgs": ["--permission", "--allow-fs-read=/Users/me/.claude*", "--allow-fs-write=/Users/me/.wasitme", "..."],
///       "scanCli": "/Users/me/.wasitme/current/engine/dist/src/cli/main.js",
///       "claudeDir": "/Users/me/.claude", "codexDir": "/Users/me/.codex" }
///
/// `schema` and `version` are optional. Paths must be absolute (`~` is not expanded) because a GUI app
/// inherits no useful PATH. The app never searches for node and never guesses.
///
/// `scanArgs` / `scanCli` (PRIVACY.md, sandbox): the Node sandbox flags the installer gives the background scan, so the app's
/// "Scan now" runs under the same grants. An absent key (an engine.json from before these fields) or an empty array
/// (this node has no permission model) means no sandbox; anything else that is not a valid sandbox makes the config
/// unusable, never a silently unsandboxed scan.
///
/// `claudeDir` / `codexDir`: the agent folders this install tracks. The app uses them only when it has no
/// `CLAUDE_CONFIG_DIR` / `CODEX_HOME` of its own, which is how a user-launched app (Finder, Spotlight: no shell
/// exports, and no LaunchAgent environment) finds a custom folder (`EngineEnvironment.make`). An absent or invalid value
/// is ignored, never an error: the engine falls back to its own defaults, as it always did.
public struct EngineConfig: Equatable, Sendable {
    public var node: URL
    public var cli: URL
    public var version: String?
    /// Node options that go before the CLI for a scan: the permission flag and its `--allow-fs-read/write` grants.
    public var scanArgs: [String]
    /// The CLI as the sandboxed scan must name it (through the resolved `~/.wasitme`); nil means `cli`.
    public var scanCli: URL?
    /// Claude Code's config folder as the installer recorded it (a valid absolute path), else nil. The installer writes
    /// it in the same step, from the same variable, as the `--allow-fs-read=<folder>*` grant in `scanArgs`, so a scan
    /// that reads this folder is a scan the sandbox lets read it.
    public var claudeDir: String?
    /// Codex's config folder as the installer recorded it (a valid absolute path), else nil. Same pairing with `scanArgs`.
    public var codexDir: String?

    public init(node: URL, cli: URL, version: String? = nil, scanArgs: [String] = [], scanCli: URL? = nil,
                claudeDir: String? = nil, codexDir: String? = nil) {
        self.node = node; self.cli = cli; self.version = version; self.scanArgs = scanArgs; self.scanCli = scanCli
        self.claudeDir = claudeDir; self.codexDir = codexDir
    }

    /// Whether a scan runs under Node's permission model.
    public var scanIsSandboxed: Bool { !scanArgs.isEmpty }

    /// The full argv after `node` for one run. A scan always skips project files (SECURITY.md: only the SessionStart
    /// hook reads them) and, when the installer found a sandbox, runs under the same grants as the background scan.
    public func argv(_ action: EngineAction, arguments: [String]) -> [String] {
        guard action == .scan else { return [cli.path, action.rawValue] + arguments + ["--json"] }
        let extra = arguments.contains("--no-project-files") ? [] : ["--no-project-files"]
        let entry = scanIsSandboxed ? (scanCli ?? cli) : cli
        return scanArgs + [entry.path, action.rawValue] + arguments + extra + ["--json"]
    }
}

/// The scan's sandbox flags (engine.json `scanArgs`). Allow-listed by form, never by deny-list: only the permission
/// flag itself and file-system grants for absolute paths, so nothing here can widen the sandbox (no child processes,
/// workers, addons, WASI or network) or reach the CLI as an argument of its own.
public enum ScanSandbox {
    public static let permissionFlags: Set<String> = ["--permission", "--experimental-permission"]
    static let readPrefix = "--allow-fs-read=", writePrefix = "--allow-fs-write="
    public static let maxCount = 32

    /// Throws `.invalidConfig` unless `args` is empty or exactly one permission flag plus absolute-path grants.
    public static func validate(_ args: [String]) throws {
        guard !args.isEmpty else { return }
        guard args.count <= maxCount else { throw EngineError.invalidConfig("scanArgs has too many entries") }
        var flags = 0
        for arg in args {
            guard arg.count <= EngineConfigLoader.maxPathLength + 32 else { throw EngineError.invalidConfig("a scanArgs entry is too long") }
            guard !arg.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else {
                throw EngineError.invalidConfig("a scanArgs entry contains control characters")
            }
            if permissionFlags.contains(arg) { flags += 1; continue }
            guard let prefix = [readPrefix, writePrefix].first(where: { arg.hasPrefix($0) }) else {
                throw EngineError.invalidConfig("scanArgs may hold only the permission flag and --allow-fs-read/--allow-fs-write grants")
            }
            let path = arg.dropFirst(prefix.count)
            // Some Node versions split a grant on commas: one grant must name exactly one absolute path.
            guard path.hasPrefix("/"), !path.contains(",") else {
                throw EngineError.invalidConfig("a scanArgs grant must name one absolute path")
            }
        }
        guard flags == 1 else { throw EngineError.invalidConfig("scanArgs must hold exactly one permission flag") }
    }

    /// The paths the scan may write to (its `--allow-fs-write=` grants).
    public static func writeGrants(_ args: [String]) -> [String] {
        args.compactMap { $0.hasPrefix(writePrefix) ? String($0.dropFirst(writePrefix.count)) : nil }
    }
}

public enum EngineConfigLoader {
    static let maxBytes = 64 * 1024
    static let maxPathLength = 4096

    private struct Raw: Decodable {
        var schema: String?
        var node: String?
        var cli: String?
        var version: String?
        /// nil: the key is absent (an engine.json from before the sandbox fields). `.some(nil)`: present but not the
        /// right type, which is refused rather than read as "no sandbox".
        var scanArgs: [String]??
        var scanCli: String??
        /// Absent, null or not a string all give nil: these two are conveniences, not safety, so they are ignored rather
        /// than refused (see `validDir`).
        var claudeDir: String?
        var codexDir: String?
        enum Keys: String, CodingKey { case schema, node, cli, version, scanArgs, scanCli, claudeDir, codexDir }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            schema = c.lossy(String.self, .schema)
            node = c.lossy(String.self, .node)
            cli = c.lossy(String.self, .cli)
            version = c.lossy(String.self, .version)
            scanArgs = c.contains(.scanArgs) ? .some(try? c.decode([String].self, forKey: .scanArgs)) : nil
            scanCli = c.contains(.scanCli) ? .some(try? c.decode(String.self, forKey: .scanCli)) : nil
            claudeDir = c.lossy(String.self, .claudeDir)
            codexDir = c.lossy(String.self, .codexDir)
        }
    }

    /// Loads and validates `engine.json`. Throws `EngineError.notConfigured` when the file is absent
    /// and `.invalidConfig` for everything else that is wrong with it.
    public static func load(from directory: WasitmeDirectory, fileManager: FileManager = .default) throws -> EngineConfig {
        let url = directory.engineConfigURL
        guard fileManager.fileExists(atPath: url.path) else { throw EngineError.notConfigured }
        guard let sig = FileSignature.of(url) else { throw EngineError.invalidConfig("not a regular file") }
        guard sig.size <= Int64(maxBytes) else { throw EngineError.invalidConfig("file is unreasonably large") }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw EngineError.invalidConfig("could not read the file") }
        let config = try parse(data, fileManager: fileManager)
        try checkWriteGrants(config.scanArgs, directory: directory)
        return config
    }

    /// The sandboxed scan may write only to wasitme's own folder (PRIVACY.md, sandbox): every `--allow-fs-write` grant must be that
    /// folder, in either spelling (the installer grants `~/.wasitme` and its resolved path, e.g. /var vs /private/var).
    static func checkWriteGrants(_ scanArgs: [String], directory: WasitmeDirectory) throws {
        let own = realPath(directory.url.path)
        for path in ScanSandbox.writeGrants(scanArgs) where realPath(path) != own {
            throw EngineError.invalidConfig("scanArgs lets the scan write outside wasitme's folder")
        }
    }

    /// realpath(3): every symlink resolved, /var → /private/var included. (`URL.resolvingSymlinksInPath` strips a
    /// leading /private again, which is not the spelling Node's permission model checks.) Unresolvable: the
    /// standardized path.
    static func realPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return URL(fileURLWithPath: path).standardizedFileURL.path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Parsing and validation without touching `engine.json` itself (the paths inside are checked).
    public static func parse(_ data: Data, fileManager: FileManager = .default) throws -> EngineConfig {
        let raw: Raw
        do { raw = try JSONDecoder().decode(Raw.self, from: data) }
        catch { throw EngineError.invalidConfig("not a JSON object") }

        if let schema = raw.schema {
            guard let id = SchemaID.parse(schema), id.name == "wasitme.engine" else {
                throw EngineError.invalidConfig("unrecognised schema")
            }
            guard id.major == ContractKind.supportedMajor else {
                throw EngineError.invalidConfig("written by a newer version (\(schema)); \(WasitmeIdentity.updateNeededMessage)")
            }
        }
        guard let nodePath = raw.node else { throw EngineError.invalidConfig("no \"node\" path") }
        guard let cliPath = raw.cli else { throw EngineError.invalidConfig("no \"cli\" path") }
        try checkPath(nodePath, label: "node")
        try checkPath(cliPath, label: "cli")

        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: nodePath, isDirectory: &isDir), !isDir.boolValue else {
            throw EngineError.invalidConfig("node does not exist at the configured path")
        }
        guard fileManager.isExecutableFile(atPath: nodePath) else {
            throw EngineError.invalidConfig("node is not executable")
        }
        isDir = false
        guard fileManager.fileExists(atPath: cliPath, isDirectory: &isDir), !isDir.boolValue else {
            throw EngineError.invalidConfig("the engine CLI does not exist at the configured path")
        }
        guard fileManager.isReadableFile(atPath: cliPath) else {
            throw EngineError.invalidConfig("the engine CLI is not readable")
        }
        var scanArgs: [String] = []
        if let field = raw.scanArgs {
            guard let args = field else { throw EngineError.invalidConfig("\"scanArgs\" is not a list of strings") }
            try ScanSandbox.validate(args)
            scanArgs = args
        }
        var scanCli: URL?
        if let field = raw.scanCli {
            guard let path = field else { throw EngineError.invalidConfig("\"scanCli\" is not a path") }
            try checkPath(path, label: "scanCli")
            isDir = false
            guard fileManager.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue, fileManager.isReadableFile(atPath: path) else {
                throw EngineError.invalidConfig("the sandboxed scan's CLI does not exist at the configured path")
            }
            scanCli = URL(fileURLWithPath: path)
        }
        return EngineConfig(node: URL(fileURLWithPath: nodePath), cli: URL(fileURLWithPath: cliPath), version: raw.version,
                            scanArgs: scanArgs, scanCli: scanCli,
                            claudeDir: validDir(raw.claudeDir, label: "claudeDir"), codexDir: validDir(raw.codexDir, label: "codexDir"))
    }

    /// A recorded agent folder, held to exactly the rule every other path in engine.json meets (`checkPath`: absolute,
    /// at most `maxPathLength`, no control characters; `~` is never expanded). Unlike those paths it is not required to
    /// exist (the installer records `~/.codex` for a Codex that is not installed yet), and one that fails is dropped
    /// rather than making engine.json unusable: the app then simply has no folder to hand the engine.
    static func validDir(_ path: String?, label: String) -> String? {
        guard let path, (try? checkPath(path, label: label)) != nil else { return nil }
        return path
    }

    private static func checkPath(_ path: String, label: String) throws {
        guard path.hasPrefix("/") else { throw EngineError.invalidConfig("\(label) path must be absolute") }
        guard path.count <= maxPathLength else { throw EngineError.invalidConfig("\(label) path is too long") }
        guard !path.unicodeScalars.contains(where: { $0.value == 0 || $0.value < 0x20 }) else {
            throw EngineError.invalidConfig("\(label) path contains control characters")
        }
    }
}

/// Allow-list for extra command-line arguments. Argument injection into our own CLI is the only
/// remaining risk with no shell involved, so values are held to a conservative character set and
/// size; tighten to an exact flag allow-list once the CLI's flags are frozen.
public enum EngineArguments {
    public static let maxCount = 16
    public static let maxLength = 256

    static func isAllowedCharacter(_ u: Unicode.Scalar) -> Bool {
        switch u {
        case "a"..."z", "A"..."Z", "0"..."9": true
        case ".", "_", "-", ":", "=", ",", "/", "@", "+": true
        default: false
        }
    }

    public static func validate(_ arguments: [String]) throws {
        guard arguments.count <= maxCount else {
            throw EngineError.invalidArgument("too many arguments (max \(maxCount))")
        }
        for argument in arguments {
            guard !argument.isEmpty, argument.count <= maxLength else {
                throw EngineError.invalidArgument("an argument is empty or longer than \(maxLength) characters")
            }
            guard argument.unicodeScalars.allSatisfy(isAllowedCharacter) else {
                throw EngineError.invalidArgument("an argument contains characters outside [A-Za-z0-9._:=,/@+-]")
            }
            guard argument != "--json" else {
                throw EngineError.invalidArgument("--json is always added by the runner")
            }
        }
    }
}

/// The child's environment, built from nothing. A GUI app's environment can hold unrelated secrets
/// (API keys exported in a login shell, tokens), none of which the engine needs.
public enum EngineEnvironment {
    /// Variables copied from the app's own environment when present.
    public static let passthrough = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
                                     "CLAUDE_CONFIG_DIR", "CODEX_HOME"]

    /// - Parameters:
    ///   - claudeDir: `EngineConfig.claudeDir`, where the installer recorded Claude Code's folder.
    ///   - codexDir: `EngineConfig.codexDir`, the same for Codex.
    ///
    /// `CLAUDE_CONFIG_DIR` and `CODEX_HOME` each come from the app's own environment when it has a value there (a shell,
    /// or the LaunchAgent the installer wrote, which sets them only for a non-default folder). Only when it has none does
    /// the folder recorded in engine.json stand in, so an app opened from Finder or Spotlight reads the same folders as
    /// the background scan. A recorded folder that is just `<HOME>/.claude` or `<HOME>/.codex` is not passed on: the
    /// installer never sets the variable for the defaults (scripts/lib/macos.sh), and setting `CLAUDE_CONFIG_DIR` to the
    /// default would change where the engine looks for Claude Code's global state file (`<folder>/.claude.json` rather
    /// than `~/.claude.json`).
    ///   - node: the node the engine runs on; its folder leads PATH. nil (the installer's scripts run without a usable
    ///     engine.json): system tools only.
    public static func make(base: [String: String], node: URL?, claudeDir: String? = nil, codexDir: String? = nil) -> [String: String] {
        var env: [String: String] = [:]
        for key in passthrough { if let v = base[key], !v.isEmpty { env[key] = v } }
        let home = base["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        useRecorded(claudeDir, for: "CLAUDE_CONFIG_DIR", defaultName: ".claude", home: home, in: &env)
        useRecorded(codexDir, for: "CODEX_HOME", defaultName: ".codex", home: home, in: &env)
        // node's own directory first, then system tools. (The engine must not rely on the user's PATH.)
        env["PATH"] = ((node.map { [$0.deletingLastPathComponent().path] } ?? []) + ["/usr/bin", "/bin"]).joined(separator: ":")
        env["NO_COLOR"] = "1"
        return env
    }

    /// The engine takes an empty or blank variable as unset (readers/claude.ts, extract/configsnap/paths.ts), so so does this.
    private static func isSet(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func useRecorded(_ dir: String?, for key: String, defaultName: String, home: String, in env: inout [String: String]) {
        guard !isSet(env[key]), let dir else { return }
        // The installer compares with `$HOME/<default>` as plain strings, HOME without a trailing slash.
        var homePath = home
        while homePath.count > 1, homePath.hasSuffix("/") { homePath.removeLast() }
        guard dir != homePath + "/" + defaultName else { return }
        env[key] = dir
    }
}
