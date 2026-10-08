import Foundation

/// Every string in a glance or snapshot is engine-owned text that surfaces render as plain text
/// (docs/CONTRACT.md#display-rules): no HTML, Markdown or escapes, with control, bidi and invisible
/// characters stripped and the length bounded. `contract/fixtures/glance/hostile-labels.json` is the
/// worst case the schema allows; every surface renders it through this type.
///
/// What it does, in order:
///  1. Removes whole terminal escape sequences (CSI `ESC [ ... final`, OSC `ESC ] ... BEL|ESC \`,
///     DCS/SOS/PM/APC `... ESC \`, and their single-character C1 forms), not just the ESC byte, so no
///     `[31m` residue is left behind.
///  2. Drops C0/C1 controls, bidi controls, zero-width/invisible characters, tag characters and
///     private-use characters (which can impersonate system glyphs). Line breaks, tabs and other
///     separators become a space.
///  3. Collapses whitespace runs (including ideographic spaces) to one space and trims the ends.
///  4. Caps stacked combining marks at `maxCombiningMarks` per base character ("Zalgo").
///  5. Bounds the result to `maxCharacters` user-perceived characters, ending with "…" when cut.
///
/// Width on screen is the view's job (line limits, truncation); this only bounds the character count.
public enum TextSanitizer {
    public static let maxCombiningMarks = 3

    public static func clean(_ raw: String, maxCharacters: Int) -> String {
        let stripped = stripEscapeSequences(raw.unicodeScalars)
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        var marksOnBase = 0
        for scalar in stripped {
            switch classify(scalar) {
            case .drop:
                continue
            case .space:
                pendingSpace = !out.isEmpty
                marksOnBase = 0
            case .mark:
                guard !out.isEmpty, !pendingSpace else { continue }     // a mark with no base is dropped
                marksOnBase += 1
                if marksOnBase <= maxCombiningMarks { out.append(scalar) }
            case .keep:
                if pendingSpace { out.append(" "); pendingSpace = false }
                out.append(scalar)
                marksOnBase = 0
            }
        }
        return bound(String(out), maxCharacters: maxCharacters)
    }

    /// Cuts to at most `maxCharacters` characters (grapheme clusters), with a trailing ellipsis when cut.
    public static func bound(_ s: String, maxCharacters: Int) -> String {
        guard maxCharacters > 0 else { return "" }
        guard s.count > maxCharacters else { return s }
        let kept = s.prefix(maxCharacters - 1).trimmingCharacters(in: .whitespaces)
        return kept + "…"
    }

    // MARK: internals

    private enum Kind { case keep, drop, space, mark }

    private static func classify(_ s: Unicode.Scalar) -> Kind {
        let v = s.value
        switch v {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029: return .space   // tabs, line/paragraph breaks, NEL
        case 0x00...0x1F, 0x7F, 0x80...0x9F: return .drop                      // C0, DEL, C1
        case 0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B...0x180F,
             0x200B...0x200F, 0x202A...0x202E, 0x2060...0x206F, 0x3164, 0xFEFF, 0xFFA0,
             0xFFF9...0xFFFB, 0x1BCA0...0x1BCA3, 0x1D173...0x1D17A:
            return .drop                                                        // invisible, joiners, bidi controls
        case 0xE0000...0xE007F, 0xE0100...0xE01EF: return .drop                 // tags, variation selectors supplement
        case 0xE000...0xF8FF, 0xF0000...0xFFFFD, 0x100000...0x10FFFD: return .drop // private use
        default: break
        }
        if s.properties.isWhitespace { return .space }
        switch s.properties.generalCategory {
        case .nonspacingMark, .enclosingMark, .spacingMark: return .mark
        case .control, .format, .surrogate, .unassigned, .privateUse, .lineSeparator, .paragraphSeparator:
            return .drop
        default: return .keep
        }
    }

    /// Removes ANSI/ECMA-48 sequences whole. Unterminated strings run to the end of the text.
    private static func stripEscapeSequences(_ input: String.UnicodeScalarView) -> [Unicode.Scalar] {
        let scalars = Array(input)
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(scalars.count)
        var i = 0
        func skipCSI(from start: Int) -> Int {          // parameters/intermediates, then one final byte 0x40-0x7E
            var j = start
            while j < scalars.count, (0x20...0x3F).contains(scalars[j].value) { j += 1 }
            if j < scalars.count, (0x40...0x7E).contains(scalars[j].value) { j += 1 }
            return j
        }
        func skipString(from start: Int) -> Int {       // until BEL, ST (ESC \) or C1 ST (0x9C)
            var j = start
            while j < scalars.count {
                let c = scalars[j].value
                if c == 0x07 || c == 0x9C { return j + 1 }
                if c == 0x1B, j + 1 < scalars.count, scalars[j + 1] == "\\" { return j + 2 }
                j += 1
            }
            return j
        }
        while i < scalars.count {
            let c = scalars[i].value
            if c == 0x1B {
                guard i + 1 < scalars.count else { i += 1; continue }
                switch scalars[i + 1] {
                case "[": i = skipCSI(from: i + 2)
                case "]", "P", "X", "^", "_": i = skipString(from: i + 2)
                default: i += 2                          // two-character escape (ESC c, ESC 7, ...)
                }
                continue
            }
            if c == 0x9B { i = skipCSI(from: i + 1); continue }                    // C1 CSI
            if c == 0x9D || c == 0x90 || c == 0x98 || c == 0x9E || c == 0x9F {    // C1 OSC/DCS/SOS/PM/APC
                i = skipString(from: i + 1); continue
            }
            out.append(scalars[i])
            i += 1
        }
        return out
    }
}
