import Foundation

// Shared vocabulary of glance.v1 and snapshot.v1 (frozen; docs/CONTRACT.md, DECISIONS D22).
//
// Tolerance rules (contract display rules):
//  - `VerdictState` never fails to decode; an unknown or missing value is `.unclear`.
//  - `VerdictReason` and other closed enums are strict; the containing model reads them with `lossy`,
//    so an unknown value becomes nil ("no claim") rather than an error.
//  - `ChangeSide` never fails to decode; an unknown value is `.unknown` — never `.agent`.
//  - `AgentID` is an open string, because new agents (OpenCode, Cursor, ...) will be added.
//  - `stale` is a display state the app computes (`Freshness`, `MenuBarGlyph.stale`), never a verdict.

/// Which coding agent a verdict is about. Open-ended on purpose: unknown ids still decode and render.
public struct AgentID: RawRepresentable, Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }

    public static let claudeCode = AgentID("claude-code")
    public static let codex = AgentID("codex")

    public var description: String { rawValue }

    /// Human-readable name for placeholder UI; unknown ids fall back to the raw id.
    public var displayName: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        default: rawValue
        }
    }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// The D22 verdict. Raw values are the contract's; `.unclear` is also what any unknown value decodes to.
/// (`noDetectableChange` is the contract's `none`; a Swift case named `none` would be confused with
/// `Optional.none` wherever a state is optional.)
public enum VerdictState: String, Sendable, Codable, CaseIterable {
    case insufficient
    case noDetectableChange = "none"
    case unclear
    case you
    case agent

    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap(VerdictState.init(rawValue:)) ?? .unclear
    }
}

/// Why the decision table landed where it did (METHOD.md §11). nil = the state needs no reason
/// (you; agent with an agent-strong candidate; none) or the value was unknown.
public enum VerdictReason: String, Sendable, Codable, CaseIterable {
    case calibrationPending = "calibration_pending"
    case needsData = "needs_data"
    case singleIndicator = "single_indicator"
    case mixed
    case workload
    case unknownProvenance = "unknown_provenance"
    case bothSides = "both_sides"
    case nothingRecordedOnYourSide = "nothing_recorded_on_your_side"
    case blindSpot = "blind_spot"
    case byElimination = "by_elimination"
}

/// Who initiated a change (METHOD.md §9). Unknown values decode to `.unknown`, which never counts as `.agent`.
public enum ChangeSide: String, Sendable, Codable, CaseIterable {
    case you
    case agent
    case unknown
    /// wasitme's own writes, or a parser change.
    case meta

    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap(ChangeSide.init(rawValue:)) ?? .unknown
    }
}

public enum ChangeStrength: String, Sendable, Codable, CaseIterable {
    case strong, weak, routine
}

public enum ChangeProvenance: String, Sendable, Codable, CaseIterable {
    case command
    case settingsSnapshot = "settings_snapshot"
    case projectSnapshot = "project_snapshot"
    case orgSettings = "org_settings"
    case logField = "log_field"
    case attachment
}

public enum MetricStatus: String, Sendable, Codable, CaseIterable {
    case worse, better, none, ineligible
}

public enum MetricFamily: String, Sendable, Codable, CaseIterable {
    case errors, research, friction
}

public enum MetricRole: String, Sendable, Codable, CaseIterable {
    /// Counts toward the verdict.
    case vote
    /// Shown beside the verdict, never decides (friction metrics).
    case support
    /// Shown for context only.
    case context

    /// Unknown roles decode to `.context`: a metric the app does not understand must not vote.
    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap(MetricRole.init(rawValue:)) ?? .context
    }
}

/// Why the last scan failed, as a kind (the contract never carries text). Unknown kinds read as `.internal`.
public enum ScanErrorKind: String, Sendable, Codable, CaseIterable {
    case permissionDenied = "permission_denied"
    case writeFailed = "write_failed"
    case timeout
    case `internal`

    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap(ScanErrorKind.init(rawValue:)) ?? .internal
    }
}

/// Layout the engine chose (D28): lead with the change timeline or with the verdict. Unknown → `.timeline`.
public enum Lead: String, Sendable, Codable, CaseIterable {
    case timeline, verdict

    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap(Lead.init(rawValue:)) ?? .timeline
    }
}

/// Integer totals for one window: k events over n opportunities (readsPerEdit: k reads over n edits).
public struct KN: Equatable, Sendable, Codable {
    public var k: Int
    public var n: Int

    public init(k: Int, n: Int) { self.k = k; self.n = n }

    /// k/n, or nil when there were no opportunities.
    public var rate: Double? { n > 0 ? Double(k) / Double(n) : nil }
}

/// The contract's `privacy` block. `containsText` must be the boolean `false`; a consumer refuses
/// a document that says anything else or says nothing (see `ContractDecoder`). `nil` here means
/// "absent or mistyped", which is not the same as `false`.
public struct PrivacyDeclaration: Equatable, Sendable, Codable {
    public var containsText: Bool?

    public init(containsText: Bool?) { self.containsText = containsText }

    enum CodingKeys: String, CodingKey { case containsText }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        containsText = c.lossy(Bool.self, .containsText)
    }
}
