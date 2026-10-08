/**
 * Last checks before anything is printed (terminal output strips C0/C1 control characters, SECURITY.md "Hostile input
 * handling"; the copy lint, METHOD.md §1):
 *
 *  - `copyProblems(doc)`: the copy lints (`lintCopy`) over every engine-owned string in the document, the glance-word
 *    rule on the glance strings, and D57's "no verdict" rule. A document that fails is not shown: the problem list
 *    names fields, never text. (Documents the engine wrote already passed these in `buildOutputs`; this catches a file
 *    that was edited or came from another version.)
 *  - `safeTerminalText(text)`: true when the only control characters are newlines and the SGR colour codes the design
 *    system writes (ESC, "[", digits and semicolons, "m"). Anything else is a bug in a renderer, and the caller
 *    refuses to print it.
 */
import { lintCopy } from "../contract/check.js";
import { GLANCE_BANNED } from "../words/lint.js";
import type { ReportDoc } from "./doc.js";

export function copyProblems(doc: ReportDoc): string[] {
  const out: string[] = [];
  const check = (at: string, text: string, glance = false): void => {
    if (text === "") return;
    for (const what of lintCopy(text)) out.push(`${at}: ${what}`);
    if (/\bverdicts?\b/i.test(text)) out.push(`${at}: says "verdict"`);
    if (glance && GLANCE_BANNED.test(text)) out.push(`${at}: glance string uses a banned word`);
  };
  doc.agents.forEach((a, i) => {
    const at = `agents[${i}]`;
    check(`${at}.label`, a.label, true);
    check(`${at}.statusLine`, a.statusLine, true);
    check(`${at}.band`, a.band, true);
    for (const f of ["headline", "because", "tryThis", "confidence"] as const) check(`${at}.${f}`, a[f]);
    check(`${at}.observation.note`, a.observation.note);
    if (a.disclaimer !== null) check(`${at}.disclaimer`, a.disclaimer);
    a.timeline.forEach((e, k) => check(`${at}.timeline[${k}].label`, e.label));
    a.metrics.forEach((m, k) => {
      check(`${at}.metrics[${k}].label`, m.label);
      check(`${at}.metrics[${k}].unit`, m.unit);
    });
    a.trace.forEach((t, k) => check(`${at}.trace[${k}]`, t.text));
  });
  return out;
}

/** Code points that can act on a terminal, reorder or hide text: controls, C1, bidi, zero-width, line separators, BOM. */
const BAD_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];

const SGR = /\x1b\[[0-9;]*m/g;

/** True when `text` holds no control, bidi or invisible character except newlines and the design system's SGR codes. */
export function safeTerminalText(text: string): boolean {
  for (const ch of text.replace(SGR, "")) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) continue;
    for (const [lo, hi] of BAD_RANGES) if (cp >= lo && cp <= hi) return false;
  }
  return true;
}
