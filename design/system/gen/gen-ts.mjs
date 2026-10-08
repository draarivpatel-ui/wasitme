// tokens.json -> generated/tokens.ts (CLI, status line, Claude Code mod pane). Erasable TypeScript only
// (no enums, no namespaces) so Node can run it with type stripping and the engine can import it unchanged.
import { HEADER, sizeEntries } from './lib.mjs';

const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('$') ? undefined : v)));

export function ts(t) {
  const data = {
    color: t.color,
    states: Object.fromEntries([...t.states.order, ...t.states.displayOnly].map(s => {
      const v = t.states[s];
      return [s, { label: v.label, headline: v.headline, legend: v.legend, textGlyph: v.textGlyph, ascii: v.ascii, voiceOver: v.voiceOver }];
    })),
    stateOrder: t.states.order,
    appStates: {
      order: t.appStates.order,
      chip: t.appStates.chip,
      ...Object.fromEntries(t.appStates.order.map(s => [s, { label: t.appStates[s].label, legend: t.appStates[s].legend }])),
    },
    newEvent: { text: t.states.newEvent.text },
    terminal: { sgr: strip(t.terminal.sgr), backgrounds: strip(t.terminal.backgrounds) },
    modPane: strip(t.modPane),
    copy: { privacyLine: t.copy.privacyLine, privacyShort: t.copy.privacyShort, disclaimer: t.copy.disclaimer, tagline: t.copy.tagline, question: t.copy.question },
    glanceBanned: t.copy.glanceBanned.pattern,
    size: Object.fromEntries(sizeEntries(t).map(e => [e.name, e.value !== undefined ? e.value : { width: e.w, height: e.h }])),
    chart: {
      strip: Object.fromEntries(Object.entries(t.chart.strip).filter(([, v]) => typeof v === 'number')),
      ratio: { domain: t.chart.ratio.domain, ticks: t.chart.ratio.ticks, rangeStroke: t.chart.ratio.rangeStroke },
      timelineRule: t.chart.timeline.rule,
    },
  };
  const body = JSON.stringify(data, null, 2);
  return `// ${HEADER}
// Zero dependencies. Import from the engine/CLI and the Claude Code mod; never hand-edit.

export const tokens = ${body} as const;

export type FindingState = keyof typeof tokens.states;
export type Party = 'you' | 'agent';
export type ColorMode = 'none' | 'ansi16' | 'ansi256-dark' | 'ansi256-light' | 'truecolor-dark' | 'truecolor-light';

const ESC = '\\u001b[';
const wrap = (sgr: string, text: string): string => (sgr ? ESC + sgr + 'm' + text + ESC + '0m' : text);
const rgb = (hex: string): string => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';');

/** Pick the colour mode from the environment (see tokens.json terminal.choose). */
export function chooseMode(env: Record<string, string | undefined>, isTTY: boolean): ColorMode {
  if (!isTTY || env.NO_COLOR !== undefined || env.TERM === 'dumb') return 'none';
  const fgbg = env.COLORFGBG ?? '';
  const light = /;(15|7)$/.test(fgbg);
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return light ? 'truecolor-light' : 'truecolor-dark';
  if ((env.TERM ?? '').includes('256color')) return light ? 'ansi256-light' : 'ansi256-dark';
  return 'ansi16';
}

/** A party sticker: " 1 " on canary or " A " on blue; reverse video in 16 colours; "[1]" / "[A]" without colour. */
export function sticker(party: Party, text: string, mode: ColorMode): string {
  if (mode === 'none') return '[' + text + ']';
  const key = party === 'you' ? 'stickerYou' : 'stickerAgent';
  if (mode === 'ansi16') return wrap(tokens.terminal.sgr.ansi16[key], ' ' + text + ' ');
  if (mode === 'ansi256-dark' || mode === 'ansi256-light') {
    const m = mode === 'ansi256-dark' ? tokens.terminal.sgr.ansi256.dark : tokens.terminal.sgr.ansi256.light;
    return wrap(m[key], ' ' + text + ' ');
  }
  const c = (mode === 'truecolor-dark' ? tokens.color.dark : tokens.color.light).party[party];
  return wrap('38;2;' + rgb(c.ink) + ';48;2;' + rgb(c.fill), ' ' + text + ' ');
}

/** Secondary text, rules and emphasis: explicit greys in 256 and truecolor modes, SGR 2 only in 16 colours. Never bold on box-drawing glyphs. */
export function styled(role: 'muted' | 'rule' | 'emphasis' | 'brandUnderline', text: string, mode: ColorMode): string {
  if (mode === 'none') return text;
  if (role === 'brandUnderline') return wrap('4', text);
  if (role === 'emphasis') return wrap('1', text);
  // 16 colours: no grey is safe without knowing the palette, so muted text and rules use SGR 2 (dim) here only.
  if (mode === 'ansi16') return wrap(role === 'muted' ? tokens.terminal.sgr.ansi16.muted : tokens.terminal.sgr.ansi16.rule, text);
  if (mode === 'truecolor-dark' || mode === 'truecolor-light') {
    const g = mode === 'truecolor-dark' ? tokens.terminal.sgr.truecolor.dark : tokens.terminal.sgr.truecolor.light;
    return wrap('38;2;' + rgb(role === 'muted' ? g.muted : g.rule), text);
  }
  const m = mode === 'ansi256-dark' ? tokens.terminal.sgr.ansi256.dark : tokens.terminal.sgr.ansi256.light;
  return wrap(role === 'muted' ? m.muted : m.rule, text);
}

/** The three-cell text glyph, or its ASCII fallback. */
export function stateGlyph(state: FindingState, ascii = false): string {
  return ascii ? tokens.states[state].ascii : tokens.states[state].textGlyph;
}

/** One-row status line: the state and an optional new-change count. Never a cause, never a quality word. */
export function statusLine(state: FindingState, newChanges: number, mode: ColorMode, ascii = false): string {
  const s = tokens.states[state];
  let label: string = s.label.toLowerCase();
  if (state === 'you') label = sticker('you', label, mode);
  else if (state === 'agent') label = sticker('agent', label, mode);
  const extra = newChanges > 0 ? '  ' + styled('muted', tokens.newEvent.text.replace('{n}', String(newChanges)), mode) : '';
  const brand = 'wasit' + styled('brandUnderline', 'me', mode);
  return brand + '  ' + stateGlyph(state, ascii) + ' ' + label + extra;
}

/** Mod-pane sticker props for a Claude Code theme name. */
export function modSticker(party: Party, claudeTheme: string): { color: string; backgroundColor: string } {
  const t = claudeTheme.toLowerCase();
  const fam = t.includes('ansi') ? 'ansi' : t.includes('light') ? 'light' : 'dark';
  const m = tokens.modPane.byClaudeTheme[fam];
  return party === 'you' ? m.stickerYou : m.stickerAgent;
}
`;
}
