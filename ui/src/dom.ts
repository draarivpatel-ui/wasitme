/**
 * Turns a VNode tree into DOM. The only DOM-writing code in the canvas: createElement / createElementNS /
 * createTextNode / setAttribute, never innerHTML, insertAdjacentHTML, document.write or a style attribute (the CSP
 * forbids inline style; a CSP is a backstop, this is the rule). Attribute names are allow-listed by shape and the
 * dangerous ones (event handlers, style, URLs) are refused outright, so even a bug elsewhere can't smuggle them in.
 */

import type { Act, Kid } from "./vnode.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NAME_OK = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const NAME_BANNED = /^(on|style$|href$|src$|srcset$|srcdoc$|action$|formaction$|xlink:|xmlns)/i;
const TAG_OK = /^[a-zA-Z][a-zA-Z0-9]*$/;
const TAG_BANNED = /^(script|style|iframe|object|embed|link|meta|base|form|foreignObject|image|use|a|img|video|audio|source|animate|set)$/i;

/** A stable key per control (data-act), so focus goes back to the same control after a repaint. Every Act field that
 *  tells two controls apart is in it (two disclosures, or two Settings rows, never share a key); a switch's `enabled`
 *  is not, because it flips on every click and the switch is still the same control. */
export function actKey(a: Act): string {
  const base = [a.action, a.page ?? "", a.agent ?? "", a.index === undefined ? "" : String(a.index)].join(":");
  const more = [a.section ?? "", a.integration ?? ""];
  return more.some((x) => x !== "") ? `${base}:${more.join(":")}` : base;
}

export function materialize(v: Kid, doc: Document, onAct: (a: Act) => void): Node {
  if (typeof v === "string") return doc.createTextNode(v);
  if (!TAG_OK.test(v.tag) || TAG_BANNED.test(v.tag)) throw new Error(`refused element <${v.tag}>`);
  const el = v.svg ? doc.createElementNS(SVG_NS, v.tag) : doc.createElement(v.tag);
  for (const name of Object.keys(v.attrs)) {
    if (!NAME_OK.test(name) || NAME_BANNED.test(name)) throw new Error(`refused attribute ${name}`);
    el.setAttribute(name, v.attrs[name]!);
  }
  if (v.act) {
    const act = v.act;
    el.setAttribute("data-act", actKey(act));
    el.addEventListener("click", (ev) => { ev.preventDefault(); if (!(el as HTMLButtonElement).disabled) onAct(act); });
  }
  for (const k of v.kids) el.appendChild(materialize(k, doc, onAct));
  return el;
}
