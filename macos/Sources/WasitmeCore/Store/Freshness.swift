import Foundation

/// How current a glance is. Pure function of two timestamps; the store re-evaluates it on every poll.
///
/// Clocks go backward (the user resets the clock, NTP steps, timezone mistakes), so:
///  - an age is never negative (`max(0, ...)`);
///  - a `generatedAt` far in the future is NOT reported as "fresh forever": it is `.futureDated`
///    so the UI can say "check your clock" instead of silently trusting it;
///  - a missing/unparseable `generatedAt` is `.unknown`.
public enum Freshness: Equatable, Sendable {
    case fresh(age: TimeInterval)
    case stale(age: TimeInterval)
    /// `generatedAt` is later than now by more than the tolerance.
    case futureDated(by: TimeInterval)
    case unknown

    public static let defaultStaleAfter: TimeInterval = 2 * 60 * 60
    public static let defaultFutureTolerance: TimeInterval = 5 * 60

    public static func evaluate(
        generatedAt: Date?, now: Date,
        staleAfter: TimeInterval = defaultStaleAfter,
        futureTolerance: TimeInterval = defaultFutureTolerance
    ) -> Freshness {
        guard let generatedAt else { return .unknown }
        let delta = now.timeIntervalSince(generatedAt)
        guard delta.isFinite else { return .unknown }
        if delta < -futureTolerance { return .futureDated(by: -delta) }
        let age = max(0, delta)
        return age > staleAfter ? .stale(age: age) : .fresh(age: age)
    }

    /// True only when the data can be trusted as recent.
    public var isFresh: Bool {
        if case .fresh = self { return true }
        return false
    }
}
