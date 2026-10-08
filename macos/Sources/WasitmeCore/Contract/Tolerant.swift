import Foundation

/// Decoding helpers for the "consumers must ignore unknown fields and render unknown states as
/// unclear" rule. `Codable` already ignores unknown keys; these helpers make the rest tolerant:
/// a wrongly-typed optional field becomes nil, and one malformed array element is dropped instead
/// of failing the whole document.

/// Wrapper whose decoding never throws; `value` is nil when the element could not be decoded.
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// Optional field; absent, null or wrongly typed all give nil.
    func lossy<T: Decodable>(_ type: T.Type = T.self, _ key: Key) -> T? {
        try? decodeIfPresent(type, forKey: key)
    }

    /// Array field; absent / not an array gives [], undecodable elements are skipped.
    func lossyArray<T: Decodable>(_ type: T.Type = T.self, _ key: Key) -> [T] {
        guard let items = try? decodeIfPresent([Lossy<T>].self, forKey: key) else { return [] }
        return items.compactMap(\.value)
    }

    /// String-keyed dictionary field; undecodable entries are skipped.
    func lossyDictionary<T: Decodable>(_ type: T.Type = T.self, _ key: Key) -> [String: T] {
        guard let items = try? decodeIfPresent([String: Lossy<T>].self, forKey: key) else { return [:] }
        return items.compactMapValues(\.value)
    }

    /// Timestamp field using `ContractDate` (accepts fractional seconds); nil if absent or invalid.
    func lossyDate(_ key: Key) -> Date? {
        guard let raw = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return ContractDate.parse(raw)
    }
}

extension KeyedEncodingContainer {
    mutating func encodeDate(_ date: Date?, forKey key: Key) throws {
        guard let date else { return }
        try encode(ContractDate.format(date), forKey: key)
    }
}

/// A JSON scalar (string / number / bool / null) for fields the contract leaves open-typed,
/// such as snapshot `setup` values and confounder values.
public enum JSONScalar: Equatable, Sendable, Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON scalar") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}
