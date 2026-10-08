// tokens.json -> generated/Tokens.swift (macOS app). Plain Swift: enums + static lets, no macros.
import { colorLeaves, camel, sizeEntries, loadGlyphs, appGlyphKey, HEADER } from './lib.mjs';

const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const hexLit = h => '0x' + h.slice(1).toUpperCase();
/** A finite number as Swift source ("2", "0.25", "12.5"). */
const num = n => {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  return String(n);
};
const int = n => {
  if (!Number.isInteger(n)) throw new Error(`not an integer: ${n}`);
  return String(n);
};
/** The bundled face's PostScript name for a type.scale role. */
const postscript = (fam, s, name) => {
  const ps = s.family === 'serif' ? fam.serif.postscript[`${s.weight}${s.style === 'italic' ? 'i' : ''}`] : fam.mono.postscript[`${s.weight}`];
  if (!ps) throw new Error(`type.scale.${name}: no PostScript name`);
  return ps;
};
// "{when}" -> "\\(when)"; any other brace is a bug the test catches.
const interp = (v, args) => {
  let out = esc(v);
  for (const a of args) out = out.split(`{${a}}`).join(`\\(${a})`);
  if (/[{}]/.test(out)) throw new Error(`unfilled placeholder in "${v}"`);
  return out;
};

export function swift(t) {
  const L = [];
  L.push(`// ${HEADER}`);
  L.push('// Fonts: bundle fonts/app/*.ttf (IBM Plex Serif + IBM Plex Mono, SIL OFL 1.1) and list them under ATSApplicationFontsPath.');
  L.push('import AppKit');
  L.push('import SwiftUI');
  L.push('');
  L.push('public enum Tokens {');
  // colours
  const light = Object.fromEntries(colorLeaves(t.color.light));
  const dark = Object.fromEntries(colorLeaves(t.color.dark));
  L.push('    /// Appearance-aware colours: each resolves to its light or dark value when drawn.');
  L.push('    public enum Palette {');
  for (const path of Object.keys(light)) {
    if (!(path in dark)) throw new Error(`colour ${path} missing in dark`);
    L.push(`        public static let ${camel(path)} = Tokens.dynamic(light: ${hexLit(light[path])}, dark: ${hexLit(dark[path])})`);
  }
  L.push('    }');
  L.push('');
  // fonts
  const fam = t.type.families;
  L.push('    /// Type roles. Serif = the finding; mono = the evidence (every number). Sizes are points.');
  L.push('    public enum Typeface {');
  L.push(`        public static let serifFamily = "${fam.serif.app}"`);
  L.push(`        public static let monoFamily = "${fam.mono.app}"`);
  for (const [name, s] of Object.entries(t.type.scale)) {
    const ps = postscript(fam, s, name);
    L.push(`        /// ${s.size}/${s.line} ${s.family}${s.style === 'italic' ? ' italic' : ''} ${s.weight}`);
    L.push(`        public static let ${name} = SwiftUI.Font.custom("${ps}", fixedSize: ${s.size})`);
    L.push(`        public static let ${name}LineHeight: CGFloat = ${s.line}`);
    L.push(`        public static let ${name}Tracking: CGFloat = ${(s.tracking * s.size).toFixed(2)}`);
  }
  L.push('    }');
  L.push('');
  L.push('    public enum Space {');
  for (const [k, v] of Object.entries(t.space)) L.push(`        public static let s${k}: CGFloat = ${v}`);
  L.push('    }');
  L.push('');
  L.push('    public enum Radius {');
  for (const [k, v] of Object.entries(t.radius)) L.push(`        public static let ${k}: CGFloat = ${v}`);
  L.push('    }');
  L.push('');
  L.push('    public enum Stroke {');
  for (const [k, v] of Object.entries(t.stroke)) L.push(`        public static let ${k}: CGFloat = ${v}`);
  L.push('    }');
  L.push('');
  L.push('    public enum Motion {');
  L.push(`        public static let duration: Double = ${(t.motion.durationMs / 1000).toFixed(3)}`);
  L.push('    }');
  L.push('');
  L.push('    /// Surface and component sizes (points). A {width, height} pair is a CGSize; other groups are flattened.');
  L.push('    public enum Size {');
  for (const e of sizeEntries(t)) {
    if (e.value !== undefined) L.push(`        public static let ${e.name}: CGFloat = ${num(e.value)}`);
    else L.push(`        public static let ${e.name} = CGSize(width: ${num(e.w)}, height: ${num(e.h)})`);
  }
  L.push('    }');
  L.push('');
  // type scale with PostScript names (what NSFont / CoreText need; SwiftUI's Font.custom takes the same name)
  L.push('    /// One type role as AppKit needs it: the bundled face\'s PostScript name, size, line box and tracking (points).');
  L.push('    public struct TypeStyle: Sendable, Equatable {');
  L.push('        public let postScriptName: String');
  L.push('        public let size: CGFloat');
  L.push('        public let lineHeight: CGFloat');
  L.push('        public let tracking: CGFloat');
  L.push('        public init(postScriptName: String, size: CGFloat, lineHeight: CGFloat, tracking: CGFloat) {');
  L.push('            self.postScriptName = postScriptName; self.size = size; self.lineHeight = lineHeight; self.tracking = tracking');
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    /// type.scale as TypeStyle values (the same numbers as Typeface.<role>, <role>LineHeight, <role>Tracking).');
  L.push('    public enum TypeScale {');
  for (const [name, s] of Object.entries(t.type.scale)) {
    L.push(`        public static let ${name} = TypeStyle(postScriptName: "${postscript(fam, s, name)}", size: ${num(s.size)}, lineHeight: ${num(s.line)}, tracking: ${(s.tracking * s.size).toFixed(2)})`);
  }
  L.push('    }');
  L.push('');
  const c = t.copy;
  L.push('    /// Fixed product sentences (tokens.json copy). The disclaimer is byte-identical to the engine\'s DISCLAIMER.');
  L.push('    public enum Copy {');
  for (const k of ['disclaimer', 'privacyShort', 'privacyLine', 'tagline', 'question']) {
    if (typeof c[k] !== 'string') throw new Error(`copy.${k} missing`);
    L.push(`        public static let ${k} = "${interp(c[k], [])}"`);
  }
  L.push('    }');
  L.push('');
  const strip = t.chart.strip, ratio = t.chart.ratio;
  L.push('    /// tokens.json chart: integer daily strips, the window ratio\'s log axis, the timeline rule (points; thresholds are counts).');
  L.push('    public enum Chart {');
  L.push('        public enum Strip {');
  for (const k of ['tickHeight', 'tickGap', 'denseTickHeight', 'denseTickGap', 'columnWidth', 'columnGap', 'compactColumnWidth', 'compactColumnGap'])
    L.push(`            public static let ${k}: CGFloat = ${num(strip[k])}`);
  L.push(`            public static let denseAbove = ${int(strip.denseAbove)}`);
  L.push(`            public static let lowNThreshold = ${int(strip.lowNThreshold)}`);
  L.push('        }');
  L.push('        public enum Ratio {');
  L.push(`            public static let domain: ClosedRange<Double> = ${num(ratio.domain[0])}...${num(ratio.domain[1])}`);
  L.push(`            public static let ticks: [Double] = [${ratio.ticks.map(num).join(', ')}]`);
  L.push(`            public static let rangeStroke: CGFloat = ${num(ratio.rangeStroke)}`);
  L.push('        }');
  L.push('        public enum Timeline {');
  L.push(`            public static let rule: CGFloat = ${num(t.chart.timeline.rule)}`);
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    /// How a chip\'s 1 pt edge is drawn (CSS border-style).');
  L.push('    public enum EdgeStyle: String, Sendable { case solid, dashed, dotted }');
  L.push('');
  // states
  const st = t.states;
  const all = [...st.order, ...st.displayOnly];
  // CONTRACT.md decision 12 / D45: the case for "none" is noDetectableChange (a case named `none` is confused with
  // Optional.none wherever a state is optional). Raw values and asset names keep the token key.
  const caseName = s => (s === 'none' ? 'noDetectableChange' : s);
  L.push('    /// Finding states (D22 order) plus the display-only `stale`. Raw values are the contract names;');
  L.push('    /// `none` is spelled `noDetectableChange` so it can never be confused with `Optional.none`.');
  L.push('    public enum FindingState: String, CaseIterable, Sendable {');
  for (const s of all) L.push(s === caseName(s) ? `        case ${s}` : `        case ${caseName(s)} = "${s}"`);
  L.push('');
  const sw = (prop, fn) => {
    L.push(`        public var ${prop}: String {`);
    L.push('            switch self {');
    for (const s of all) L.push(`            case .${caseName(s)}: return "${interp(fn(st[s], s), [])}"`);
    L.push('            }');
    L.push('        }');
  };
  sw('label', v => v.label);
  sw('headline', v => v.headline);
  sw('legend', v => v.legend);
  sw('textGlyph', v => v.textGlyph);
  sw('ascii', v => v.ascii);
  sw('menuBarImage16', (_, s) => `state-${s}-16`);
  sw('menuBarImage18', (_, s) => `state-${s}-18`);
  L.push('');
  L.push('        /// The chip\'s edge (color.<mode>.state.<state>.edgeStyle; the same in light and dark).');
  L.push('        public var edgeStyle: EdgeStyle {');
  L.push('            switch self {');
  for (const s of all) {
    const e = t.color.light.state[s].edgeStyle;
    if (e !== t.color.dark.state[s].edgeStyle) throw new Error(`state.${s}.edgeStyle differs between light and dark`);
    if (!['solid', 'dashed', 'dotted'].includes(e)) throw new Error(`state.${s}.edgeStyle: ${e}`);
    L.push(`            case .${caseName(s)}: return .${e}`);
  }
  L.push('            }');
  L.push('        }');
  L.push('');
  L.push('        /// VoiceOver label for the glyph. `lastChecked` is used only by `stale` ("2 h ago").');
  L.push('        public func voiceOver(lastChecked when: String) -> String {');
  L.push('            switch self {');
  for (const s of all) L.push(`            case .${caseName(s)}: return "${interp(st[s].voiceOver, ['when'])}"`);
  L.push('            }');
  L.push('        }');
  L.push('');
  L.push('        /// Appended to the VoiceOver label when the timeline has new changes (never while stale).');
  L.push('        public static func newChangesVoiceOver(_ n: Int) -> String {');
  L.push(`            n == 1 ? "${interp(st.newEvent.voiceOver.one, ['n'])}" : "${interp(st.newEvent.voiceOver.other, ['n'])}"`);
  L.push('        }');
  L.push('');
  L.push('        /// The "+n" beside the glyph.');
  L.push('        public static func newChangesText(_ n: Int) -> String {');
  L.push(`            "${interp(st.newEvent.text, ['n'])}"`);
  L.push('        }');
  L.push('    }');
  L.push('');
  const cp = st.calibrationPending;
  L.push('    /// Not a state (CONTRACT.md decision 12): what `insufficient` + reason `calibration_pending` displays.');
  L.push('    public enum CalibrationPending {');
  L.push(`        public static let label = "${interp(cp.label, [])}"`);
  L.push(`        public static let headline = "${interp(cp.headline, [])}"`);
  L.push(`        public static let glyph: FindingState = .${caseName(cp.usesGlyphOf)}`);
  L.push('    }');
  L.push('');
  // the app's own document states (never a finding)
  const ap = t.appStates, chip = ap.chip;
  const paletteRef = path => {
    if (!(path in light)) throw new Error(`appStates.chip names ${path}, which is not a colour`);
    return `Tokens.Palette.${camel(path)}`;
  };
  L.push('    /// The app\'s own document states (tokens.json appStates): about wasitme itself, never a finding. Their glyphs');
  L.push('    /// change the rule itself and never put a square above or a triangle below it; their chip is the quiet neutral one.');
  L.push('    public enum AppState: String, CaseIterable, Sendable {');
  for (const s of ap.order) L.push(`        case ${s}`);
  L.push('');
  const asw = (prop, fn) => {
    L.push(`        public var ${prop}: String {`);
    L.push('            switch self {');
    for (const s of ap.order) L.push(`            case .${s}: return "${interp(fn(ap[s], s), [])}"`);
    L.push('            }');
    L.push('        }');
  };
  asw('label', v => v.label);
  asw('legend', v => v.legend);
  asw('menuBarImage16', (_, s) => appGlyphKey(s, 16));
  asw('menuBarImage18', (_, s) => appGlyphKey(s, 18));
  L.push('');
  L.push('        /// The chip every app state uses (tokens.json appStates.chip: existing colours, by path).');
  L.push(`        public static let chipFg = ${paletteRef(chip.fg)}`);
  L.push(`        public static let chipBg = ${paletteRef(chip.bg)}`);
  L.push(`        public static let chipGlyph = ${paletteRef(chip.glyph)}`);
  L.push(`        public static let chipEdge = ${paletteRef(chip.edge)}`);
  if (!['solid', 'dashed', 'dotted'].includes(chip.edgeStyle)) throw new Error(`appStates.chip.edgeStyle: ${chip.edgeStyle}`);
  L.push(`        public static let chipEdgeStyle: EdgeStyle = .${chip.edgeStyle}`);
  L.push('    }');
  L.push('');
  // glyphs as vector primitives, so the app draws the design's pixels with no SVG parser and no asset catalogue
  const pt = ([x, y]) => `CGPoint(x: ${num(x)}, y: ${num(y)})`;
  const prim = p => p.kind === 'rect' ? `.rect(CGRect(x: ${num(p.x)}, y: ${num(p.y)}, width: ${num(p.w)}, height: ${num(p.h)}))`
    : p.kind === 'fill' ? `.fill([${p.pts.map(pt).join(', ')}])` : `.stroke([${p.pts.map(pt).join(', ')}], width: ${num(p.width)})`;
  L.push('    /// glyphs/*-16.svg and *-18.svg (the states, the app states, the mono mark) as vector primitives in SVG coordinates');
  L.push('    /// (y down, on the glyph\'s own pixel grid). Pure black and alpha: fill them with one colour or use them as a template.');
  L.push('    public enum Glyphs {');
  L.push('        public enum Primitive: Sendable, Equatable {');
  L.push('            case rect(CGRect)');
  L.push('            case fill([CGPoint])');
  L.push('            case stroke([CGPoint], width: CGFloat)');
  L.push('        }');
  L.push('        public struct Glyph: Sendable, Equatable {');
  L.push('            public let grid: CGFloat');
  L.push('            public let primitives: [Primitive]');
  L.push('        }');
  L.push('        /// Keyed by file name without ".svg": "state-you-16", "app-loading-18", "mark-16".');
  L.push('        public static let all: [String: Glyph] = [');
  for (const [key, g] of loadGlyphs(t)) {
    L.push(`            "${key}": Glyph(grid: ${g.size}, primitives: [`);
    for (const p of g.prims) L.push(`                ${prim(p)},`);
    L.push('            ]),');
  }
  L.push('        ]');
  L.push('    }');
  L.push('');
  L.push('    static func dynamic(light: UInt32, dark: UInt32) -> SwiftUI.Color {');
  L.push('        SwiftUI.Color(nsColor: NSColor(name: nil) { appearance in');
  L.push('            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua');
  L.push('            return Tokens.nsColor(isDark ? dark : light)');
  L.push('        })');
  L.push('    }');
  L.push('');
  L.push('    static func nsColor(_ hex: UInt32) -> NSColor {');
  L.push('        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,');
  L.push('                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)');
  L.push('    }');
  L.push('}');
  return L.join('\n') + '\n';
}
