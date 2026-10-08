// tokens.json -> generated/contrast-report.md: WCAG contrast for every declared pair (light + dark),
// terminal backgrounds and 16/256-colour stickers, and colour-vision-deficiency separation of the state colours.
import { MODES, get, contrast, deltaE, fmt, HEADER, CVD } from './lib.mjs';

const TEXT = 4.5, NONTEXT = 3, DE_NORMAL = 15, DE_SIM = 8;

export function checks(t) {
  const rows = []; // {group, mode, fg, bg, fgHex, bgHex, ratio, need}
  for (const mode of MODES) {
    const C = t.color[mode];
    for (const [kind, need] of [['text', TEXT], ['nonText', NONTEXT]])
      for (const [fg, bgs] of t.contrast[kind]) for (const bg of bgs) {
        const a = get(C, fg), b = get(C, bg);
        if (typeof a !== 'string' || typeof b !== 'string') throw new Error(`contrast pair ${fg} on ${bg}: unknown token in ${mode}`);
        rows.push({ group: `${mode} ${kind === 'text' ? 'text' : 'non-text'}`, fg, bg, fgHex: a, bgHex: b, ratio: contrast(a, b), need });
      }
  }
  // terminal + Code tab backgrounds (text): default fg and muted on each declared background
  for (const [k, v] of Object.entries(t.terminal.backgrounds)) {
    if (k.startsWith('$')) continue;
    rows.push({ group: 'terminal text', fg: `${k}.fg`, bg: `${k}.bg`, fgHex: v.fg, bgHex: v.bg, ratio: contrast(v.fg, v.bg), need: TEXT, note: v.status });
    rows.push({ group: 'terminal text', fg: `${k}.muted`, bg: `${k}.bg`, fgHex: v.muted, bgHex: v.bg, ratio: contrast(v.muted, v.bg), need: TEXT, note: v.status });
  }
  // truecolor stickers keep their own text contrast (ink on fill) - covered by the token pairs above.
  // 16-colour stickers are reverse video (SGR 7): they take the theme's own fg/bg, so no palette row applies.
  const x = t.terminal.sgr.ansi256.xterm256Hex, B = t.terminal.backgrounds;
  rows.push({ group: 'ansi256 stickers', fg: '16', bg: '221 (you)', fgHex: x['16'], bgHex: x['221'], ratio: contrast(x['16'], x['221']), need: TEXT });
  rows.push({ group: 'ansi256 stickers', fg: '16', bg: '117 (agent)', fgHex: x['16'], bgHex: x['117'], ratio: contrast(x['16'], x['117']), need: TEXT });
  // the explicit muted/rule greys of the 256-colour and truecolor modes, on every declared background of that mode
  const code = s => s.split(';').pop();
  const modeBgs = { dark: ['darkMock', 'codeTabDark'], light: ['lightMock', 'codeTabLight'] };
  for (const [mode, keys] of Object.entries(modeBgs)) for (const k of keys) {
    const bg = B[k].bg, a = t.terminal.sgr.ansi256[mode], tc = t.terminal.sgr.truecolor[mode];
    const add = (fg, hex, need) => rows.push({ group: 'terminal greys', fg, bg: `${k}.bg`, fgHex: hex, bgHex: bg, ratio: contrast(hex, bg), need, note: B[k].status });
    add(`ansi256-${mode} muted (${code(a.muted)})`, x[code(a.muted)], TEXT);
    add(`ansi256-${mode} rule (${code(a.rule)})`, x[code(a.rule)], NONTEXT);
    add(`truecolor-${mode} muted`, tc.muted, TEXT);
    add(`truecolor-${mode} rule`, tc.rule, NONTEXT);
  }

  // colour-vision separation of the state identity colours
  const ident = C => ({ insufficient: C.state.insufficient.edge, none: C.state.none.bg, you: C.party.you.fill, agent: C.party.agent.fill });
  const cvd = [];
  for (const mode of MODES) {
    const I = ident(t.color[mode]), names = Object.keys(I);
    for (const kind of ['normal', ...Object.keys(CVD)]) {
      let worst = null;
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const d = deltaE(I[names[i]], I[names[j]], kind);
        if (!worst || d < worst.d) worst = { a: names[i], b: names[j], d };
      }
      cvd.push({ mode, kind, ...worst, need: kind === 'normal' ? DE_NORMAL : DE_SIM });
    }
  }
  for (const kind of ['normal', ...Object.keys(CVD)])
    cvd.push({ mode: 'ansi256 stickers', kind, a: 'you (221)', b: 'agent (117)', d: deltaE(x['221'], x['117'], kind), need: kind === 'normal' ? DE_NORMAL : DE_SIM });
  const failures = [
    ...rows.filter(r => r.ratio < r.need).map(r => `${r.group}: ${r.fg} on ${r.bg} = ${fmt(r.ratio)} (needs ${r.need})`),
    ...cvd.filter(c => c.d < c.need).map(c => `CVD ${c.mode} ${c.kind}: ${c.a} vs ${c.b} = ${fmt(c.d, 1)} (needs ${c.need})`),
  ];
  return { rows, cvd, failures };
}

export function report(t) {
  const { rows, cvd, failures } = checks(t);
  const L = [`<!-- ${HEADER} -->`, '', '# Contrast and colour-vision report', ''];
  L.push(`Text pairs need ${TEXT}:1, non-text pairs ${NONTEXT}:1 (WCAG 2.2, 1.4.3 / 1.4.11). State colours must stay at least ${DE_SIM} apart (OKLab x100) under protanopia, deuteranopia and tritanopia (Machado 2009, severity 1.0) and ${DE_NORMAL} apart with normal vision. Decorative hairlines are exempt: ${t.contrast.decorativeWhy}`);
  L.push('');
  L.push(`**Result: ${failures.length ? `${failures.length} FAILURE(S)` : 'all pass'}** (${rows.length} contrast pairs, ${cvd.length} colour-vision checks).`);
  if (failures.length) { L.push(''); for (const f of failures) L.push(`- FAIL ${f}`); }
  const groups = [...new Set(rows.map(r => r.group))];
  for (const g of groups) {
    const rs = rows.filter(r => r.group === g);
    const worst = rs.reduce((a, b) => (a.ratio - a.need <= b.ratio - b.need ? a : b));
    L.push('', `## ${g}`, '', `Worst: ${worst.fg} on ${worst.bg}, ${fmt(worst.ratio)}:1.`, '', '| foreground | background | colours | ratio | needs | |', '|---|---|---|---:|---:|---|');
    for (const r of rs) L.push(`| ${r.fg} | ${r.bg} | ${r.fgHex} on ${r.bgHex} | ${fmt(r.ratio)} | ${r.need} | ${r.ratio >= r.need ? 'pass' : '**FAIL**'}${r.note && !r.note.startsWith('mock') ? ` (${r.note})` : ''} |`);
  }
  L.push('', '## Colour-vision separation (closest pair per mode and vision type)', '', '| palette | vision | closest pair | OKLab x100 | needs | |', '|---|---|---|---:|---:|---|');
  for (const c of cvd) L.push(`| ${c.mode} | ${c.kind} | ${c.a} vs ${c.b} | ${fmt(c.d, 1)} | ${c.need} | ${c.d >= c.need ? 'pass' : '**FAIL**'} |`);
  L.push('', '16-colour mode: stickers are reverse video (SGR 7), so they inherit the terminal theme\'s own foreground/background contrast and use no palette entry; muted text and rules are SGR 2 (dim), drawn by each terminal its own way and not checked here.');
  L.push('', 'Shape carries every state as well (glyphs, sticker shapes, numerals vs letters), so colour is never the only cue. `unclear` is drawn with both party colours and `stale` is shape-coded, so neither is in the distance table.', '');
  return L.join('\n');
}
