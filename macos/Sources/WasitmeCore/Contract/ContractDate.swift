import Foundation

/// Tolerant RFC 3339 / ISO-8601 timestamp parsing for the engine's `date-time` fields.
///
/// Why hand-rolled: `JSONDecoder.dateDecodingStrategy = .iso8601` rejects fractional seconds, and the
/// engine (Node, `Date.toISOString()`) emits `2026-10-04T21:00:00.123Z`. This parser accepts
/// `Z` / `±HH:MM` / `±HHMM` zones and any number of fractional digits, validates every field
/// (including month lengths and leap years), and uses no formatter objects (thread-safe, Sendable).
public enum ContractDate {
    public static func parse(_ raw: String) -> Date? {
        let b = Array(raw.utf8)
        var i = 0

        func digits(_ n: Int) -> Int? {
            guard i + n <= b.count else { return nil }
            var v = 0
            for k in 0..<n {
                let c = b[i + k]
                guard c >= 0x30, c <= 0x39 else { return nil }
                v = v * 10 + Int(c - 0x30)
            }
            i += n
            return v
        }
        func expect(_ ch: UInt8) -> Bool {
            guard i < b.count, b[i] == ch else { return false }
            i += 1
            return true
        }

        guard let year = digits(4), expect(0x2D),          // -
              let month = digits(2), expect(0x2D),
              let day = digits(2), expect(0x54),           // T (strict: uppercase T)
              let hour = digits(2), expect(0x3A),          // :
              let minute = digits(2), expect(0x3A),
              let second = digits(2)
        else { return nil }

        // Optional fractional seconds: '.' followed by 1...9 digits (extra digits are ignored).
        var fraction = 0.0
        if i < b.count, b[i] == 0x2E {
            i += 1
            var scale = 0.1
            var count = 0
            while i < b.count, b[i] >= 0x30, b[i] <= 0x39 {
                if count < 9 { fraction += Double(b[i] - 0x30) * scale; scale /= 10 }
                count += 1
                i += 1
            }
            guard count >= 1 else { return nil }
        }

        // Zone: Z, +HH:MM, +HHMM (required: a timestamp without a zone is ambiguous).
        var offsetSeconds = 0
        guard i < b.count else { return nil }
        if b[i] == 0x5A {                                   // Z
            i += 1
        } else if b[i] == 0x2B || b[i] == 0x2D {            // + / -
            let sign = b[i] == 0x2D ? -1 : 1
            i += 1
            guard let oh = digits(2) else { return nil }
            _ = expect(0x3A)
            guard let om = digits(2), oh <= 23, om <= 59 else { return nil }
            offsetSeconds = sign * (oh * 3600 + om * 60)
        } else {
            return nil
        }
        guard i == b.count else { return nil }

        guard (1...12).contains(month), hour <= 23, minute <= 59, second <= 59,
              (1...daysIn(month: month, year: year)).contains(day)
        else { return nil }

        let days = daysFromCivil(year: year, month: month, day: day)
        let seconds = Double(days) * 86_400 + Double(hour * 3600 + minute * 60 + second) + fraction
        return Date(timeIntervalSince1970: seconds - Double(offsetSeconds))
    }

    /// `YYYY-MM-DDTHH:mm:ss.SSSZ` in UTC (what the engine writes; used for encoding and tests).
    public static func format(_ date: Date) -> String {
        let total = date.timeIntervalSince1970
        var whole = Int(total.rounded(.down))
        var millis = Int(((total - Double(whole)) * 1000).rounded())
        if millis >= 1000 { whole += 1; millis -= 1000 }
        let days = Int((Double(whole) / 86_400).rounded(.down))
        let secOfDay = whole - days * 86_400
        let (y, m, d) = civilFromDays(days)
        func p(_ v: Int, _ w: Int) -> String { String(repeating: "0", count: max(0, w - String(v).count)) + String(v) }
        return "\(p(y, 4))-\(p(m, 2))-\(p(d, 2))T\(p(secOfDay / 3600, 2)):\(p((secOfDay / 60) % 60, 2)):\(p(secOfDay % 60, 2)).\(p(millis, 3))Z"
    }

    // MARK: - Civil calendar arithmetic (Howard Hinnant's algorithms, proleptic Gregorian)

    static func isLeap(_ y: Int) -> Bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

    static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 2: isLeap(year) ? 29 : 28
        case 4, 6, 9, 11: 30
        default: 31
        }
    }

    /// Days since 1970-01-01.
    static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func civilFromDays(_ z0: Int) -> (year: Int, month: Int, day: Int) {
        let z = z0 + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        return (m <= 2 ? y + 1 : y, m, d)
    }
}
