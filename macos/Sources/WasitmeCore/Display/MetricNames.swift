import Foundation

/// An indicator's name when a glance names it without a label of its own (a metric that came without its label), so a
/// surface never shows the raw id ("toolErrors"). The labels are word for word the engine's
/// (engine/src/words/names.ts METRIC_WORDS); the canvas (ui/src/derive.ts METRIC_LABEL) and the Claude Code pane
/// (plugin/mod/theme.ts metricName) hold the same table, and scripts/test/metric-words.test.mjs keeps all four equal.
public enum MetricNames {
    public static let label: [String: String] = [
        "toolErrors": "Tool errors", "toolErrorsNonCmd": "Tool errors (excl. commands)", "cmdFailures": "Command failures",
        "readsPerEdit": "Reads per edit", "blindEdits": "Edits without reading first", "interrupts": "Interruptions",
        "pushback": "Pushback prompts", "churn": "Files edited 3+ times",
    ]

    /// The engine's label for an id, or for an id this version does not know its words ("fooBarBaz" -> "Foo bar baz";
    /// "Indicator" when that is empty or longer than a label's 40), as the canvas and the pane spell them. Never the id.
    public static func name(_ id: String) -> String {
        if let known = label[id] { return known }
        var words = ""
        var previous: Character?
        for ch in id {
            let kept = (ch.isASCII && (ch.isLetter || ch.isNumber)) || ch == "+"
            if kept {
                if ch.isUppercase, let p = previous, p.isASCII, p.isLowercase || p.isNumber { words.append(" ") }
                words.append(contentsOf: ch.lowercased())
            } else if let last = words.last, last != " " {
                words.append(" ")
            }
            previous = ch
        }
        let trimmed = words.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first, trimmed.count <= 40 else { return "Indicator" }
        return first.uppercased() + trimmed.dropFirst()
    }
}
