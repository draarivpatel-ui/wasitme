import Foundation

/// Parsed form of a contract `schema` string such as `"wasitme.glance/1"` or `"wasitme.snapshot/1.2"`.
public struct SchemaID: Equatable, Sendable, CustomStringConvertible {
    public let name: String
    public let major: Int
    public let minor: Int?

    public var description: String { minor.map { "\(name)/\(major).\($0)" } ?? "\(name)/\(major)" }

    public init(name: String, major: Int, minor: Int? = nil) {
        self.name = name
        self.major = major
        self.minor = minor
    }

    /// Strict: `<name>/<major>` or `<name>/<major>.<minor>`, digits only. Anything else is nil.
    public static func parse(_ raw: String) -> SchemaID? {
        let parts = raw.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return nil }
        let version = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(version.count),
              let major = digits(version[0]) else { return nil }
        var minor: Int?
        if version.count == 2 {
            guard let m = digits(version[1]) else { return nil }
            minor = m
        }
        return SchemaID(name: String(parts[0]), major: major, minor: minor)
    }

    private static func digits(_ s: Substring) -> Int? {
        guard !s.isEmpty, s.count <= 6, s.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
        return Int(s)
    }
}

/// Which of the engine's documents a file is expected to be.
public enum ContractKind: String, Sendable, CaseIterable {
    case glance
    case snapshot

    /// The schema name that must appear before the `/`.
    public var schemaName: String { "wasitme.\(rawValue)" }
    /// The only major version this build of the app can decode.
    public static let supportedMajor = 1
    /// The one id this app accepts, byte for byte (`wasitme.glance/1`, `wasitme.snapshot/1`).
    /// Additive changes keep this id; minor ids (`/1.<minor>`) are reserved and never written (D45).
    public var expectedSchema: String { "\(schemaName)/\(ContractKind.supportedMajor)" }
}

/// Result of checking a document's `schema` string against what this app understands.
/// A mismatch is a normal, user-visible state ("Update needed"), never a crash or a decode error.
///
/// Only the exact id is compatible (contract display rule 1, D45): the comparison is on the string, the
/// same as the reference decoder (`engine/src/contract/display.ts`) and the mod. The other cases only
/// say *why* a string did not match, for diagnostics.
public enum SchemaCompatibility: Equatable, Sendable {
    case compatible
    /// The right document and major, but not the exact id: a reserved minor id (`wasitme.glance/1.2`) or a
    /// non-canonical spelling (`wasitme.glance/01`). Reserved ids are never written, so this is a mismatch.
    case nonCanonical(found: String)
    /// The engine is newer than this app understands (major greater than supported).
    case newerMajor(found: String)
    /// The file is from an engine older than this app understands (major lower than supported).
    case olderMajor(found: String)
    /// A well-formed schema id, but for a different document (e.g. a snapshot in glance.json).
    case wrongDocument(found: String)
    /// Missing or not of the form `<name>/<major>`.
    case unparseable(found: String?)

    public var isCompatible: Bool { self == .compatible }

    public static func check(_ rawSchema: String?, expecting kind: ContractKind) -> SchemaCompatibility {
        if rawSchema == kind.expectedSchema { return .compatible }
        guard let raw = rawSchema, let id = SchemaID.parse(raw) else { return .unparseable(found: rawSchema) }
        guard id.name == kind.schemaName else { return .wrongDocument(found: raw) }
        if id.major > ContractKind.supportedMajor { return .newerMajor(found: raw) }
        if id.major < ContractKind.supportedMajor { return .olderMajor(found: raw) }
        return .nonCanonical(found: raw)
    }
}
