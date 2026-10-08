import Foundation

/// Why a contract file could not be turned into a model. Each case is a normal, displayable state.
public enum ContractError: Error, Equatable, Sendable, CustomStringConvertible {
    /// Not a JSON object at all (empty, truncated, garbage, or a JSON array/scalar).
    case notAnObject
    /// The `schema` id is missing, of another document, or has a major this app does not understand.
    case schemaMismatch(SchemaCompatibility)
    /// Valid JSON with a compatible schema id, but the structure is unusable.
    case malformed(String)
    /// The document declares `privacy.containsText == true`; the app refuses to read it.
    case declaresText
    /// The document does not declare `privacy.containsText == false`: the block is absent, or the value
    /// is missing or of the wrong type. Both schemas require the declaration, so the app fails closed.
    case privacyUndeclared

    public var description: String {
        switch self {
        case .notAnObject: "not a JSON object"
        case .schemaMismatch(let c): "schema mismatch: \(c)"
        case .malformed(let m): "malformed: \(m)"
        case .declaresText: "document declares that it contains text"
        case .privacyUndeclared: "document does not declare that it is free of text"
        }
    }
}

/// Decoding entry points: probe the `schema` id first, refuse early on a major mismatch (the shape of
/// a newer major is unknown, so we do not even try), then decode tolerantly.
public enum ContractDecoder {
    /// Reads only `schema`; a non-string `schema` counts as missing, a non-object top level throws.
    private struct Probe: Decodable {
        let schema: String?
        enum Keys: String, CodingKey { case schema }
        init(from decoder: Decoder) throws {
            schema = try decoder.container(keyedBy: Keys.self).lossy(String.self, .schema)
        }
    }

    public static func decodeGlance(_ data: Data) throws -> Glance {
        try decode(Glance.self, from: data, kind: .glance) { $0.privacy }
    }

    public static func decodeSnapshot(_ data: Data) throws -> Snapshot {
        try decode(Snapshot.self, from: data, kind: .snapshot) { $0.privacy }
    }

    /// The compatibility of raw JSON without decoding the rest (cheap check for diagnostics).
    public static func compatibility(of data: Data, expecting kind: ContractKind) throws -> SchemaCompatibility {
        let probe: Probe
        do { probe = try JSONDecoder().decode(Probe.self, from: data) } catch { throw ContractError.notAnObject }
        return .check(probe.schema, expecting: kind)
    }

    private static func decode<T: Decodable>(
        _ type: T.Type, from data: Data, kind: ContractKind, privacy: (T) -> PrivacyDeclaration?
    ) throws -> T {
        let compat = try compatibility(of: data, expecting: kind)
        guard compat.isCompatible else { throw ContractError.schemaMismatch(compat) }
        let value: T
        do { value = try JSONDecoder().decode(T.self, from: data) }
        catch { throw ContractError.malformed(String(String(describing: error).prefix(200))) }
        // Fail closed: only an explicit `containsText: false` is accepted. An absent block or a
        // mistyped value (the string "true", a number) is as unacceptable as an explicit `true`.
        switch privacy(value)?.containsText {
        case .some(false): return value
        case .some(true): throw ContractError.declaresText
        case .none: throw ContractError.privacyUndeclared
        }
    }

    /// JSON encoder whose output the decoders above read back (timestamps as ISO-8601 strings are
    /// handled by the models themselves; keys sorted for stable test output).
    public static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }
}
