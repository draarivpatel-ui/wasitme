import Foundation

/// Cheap identity of a file on disk (inode + mtime + size). Atomic replacement changes the inode, so
/// two reads with the same signature are the same bytes; used to skip re-decoding a large snapshot.
struct FileSignature: Equatable, Sendable {
    let inode: UInt64
    let mtimeSeconds: Int
    let mtimeNanos: Int
    let size: Int64

    static func of(_ url: URL) -> FileSignature? {
        var st = stat()
        guard stat(url.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return nil }
        return FileSignature(inode: UInt64(st.st_ino), mtimeSeconds: Int(st.st_mtimespec.tv_sec),
                             mtimeNanos: Int(st.st_mtimespec.tv_nsec), size: Int64(st.st_size))
    }
}

/// What the store learned about one file on one read.
enum FileRead<Value: Sendable>: Sendable {
    /// Same signature as the last successful read: nothing to do.
    case unchanged
    case missing
    case loaded(Value)
    /// Display rule 1: not a JSON object, or not the exact schema id this app understands.
    case updateNeeded(found: String)
    /// Display rule 2: `privacy.containsText` is not the boolean `false`. Nothing from the file is shown.
    case refused(String)
    /// Unreadable or too large (an OS-level problem, not the engine's output). The message never contains file content.
    case invalid(String)
}

/// Bytes -> model, classified exactly as the store does it, so offscreen rendering (`--capture`) and the
/// live app reach the same display decision for the same file (docs/CONTRACT.md#display-rules).
public enum ContractFile {
    /// The status a surface reports for these bytes, and the decoded glance when it may be shown.
    public static func readGlance(_ data: Data) -> (status: SourceStatus, glance: Glance?) {
        switch classify(data, decode: ContractDecoder.decodeGlance) {
        case .loaded(let g): return (.ok, g)
        case .updateNeeded(let found): return (.updateNeeded(found: found), nil)
        case .refused(let why): return (.refused(why), nil)
        case .invalid(let why): return (.invalid(why), nil)
        case .missing, .unchanged: return (.missing, nil)
        }
    }

    /// Same for a snapshot.
    public static func readSnapshot(_ data: Data) -> (status: SourceStatus, snapshot: Snapshot?) {
        switch classify(data, decode: ContractDecoder.decodeSnapshot) {
        case .loaded(let s): return (.ok, s)
        case .updateNeeded(let found): return (.updateNeeded(found: found), nil)
        case .refused(let why): return (.refused(why), nil)
        case .invalid(let why): return (.invalid(why), nil)
        case .missing, .unchanged: return (.missing, nil)
        }
    }

    static func classify<V: Sendable>(_ data: Data, decode: (Data) throws -> V) -> FileRead<V> {
        do {
            return .loaded(try decode(data))
        } catch let error as ContractError {
            switch error {
            case .schemaMismatch(let compat):
                switch compat {
                case .newerMajor(let found), .olderMajor(let found), .wrongDocument(let found), .nonCanonical(let found):
                    return .updateNeeded(found: String(found.prefix(64)))
                case .unparseable(let found):
                    return .updateNeeded(found: found.map { String($0.prefix(64)) } ?? "no schema id")
                case .compatible:
                    return .invalid("unexpected schema state")
                }
            case .notAnObject: return .updateNeeded(found: "not a JSON object")
            case .malformed(let why): return .invalid("malformed: \(why)")
            case .declaresText: return .refused("document declares it contains text; refused")
            case .privacyUndeclared: return .refused("document does not declare it is text-free; refused")
            }
        } catch {
            return .invalid("decode failed")
        }
    }
}

/// Reads and decodes the engine's files off the main thread. An actor, so reads never overlap and each
/// result carries a sequence number the main-actor store uses to drop out-of-order applications.
actor StateLoader {
    struct Result: Sendable {
        let sequence: UInt64
        let glance: FileRead<Glance>
        let snapshot: FileRead<Snapshot>
    }

    private let directory: WasitmeDirectory
    private let maxGlanceBytes: Int
    private let maxSnapshotBytes: Int
    private let loadSnapshot: Bool
    private var sequence: UInt64 = 0
    private var glanceSignature: FileSignature?
    private var snapshotSignature: FileSignature?

    init(directory: WasitmeDirectory, maxGlanceBytes: Int, maxSnapshotBytes: Int, loadSnapshot: Bool) {
        self.directory = directory
        self.maxGlanceBytes = maxGlanceBytes
        self.maxSnapshotBytes = maxSnapshotBytes
        self.loadSnapshot = loadSnapshot
    }

    func load() -> Result {
        sequence += 1
        let glance = read(directory.glanceURL, limit: maxGlanceBytes, signature: &glanceSignature,
                          decode: ContractDecoder.decodeGlance)
        let snapshot: FileRead<Snapshot> = loadSnapshot
            ? read(directory.snapshotURL, limit: maxSnapshotBytes, signature: &snapshotSignature,
                   decode: ContractDecoder.decodeSnapshot)
            : .unchanged
        return Result(sequence: sequence, glance: glance, snapshot: snapshot)
    }

    private func read<V: Sendable>(
        _ url: URL, limit: Int, signature: inout FileSignature?, decode: (Data) throws -> V
    ) -> FileRead<V> {
        guard let sig = FileSignature.of(url) else {
            signature = nil
            return FileManager.default.fileExists(atPath: url.path) ? .invalid("not a regular file") : .missing
        }
        if sig == signature { return .unchanged }
        if sig.size > Int64(limit) {
            signature = nil
            return .invalid("file is larger than \(limit / 1024) KB")
        }
        let data: Data
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            // Read at most limit+1 bytes: the file may have grown since stat().
            data = try handle.read(upToCount: limit + 1) ?? Data()
        } catch {
            signature = nil
            return FileManager.default.fileExists(atPath: url.path) ? .invalid("could not read file") : .missing
        }
        if data.count > limit { signature = nil; return .invalid("file is larger than \(limit / 1024) KB") }

        signature = sig      // same bytes (good or bad): do not re-decode until the file changes
        return ContractFile.classify(data, decode: decode)
    }
}
