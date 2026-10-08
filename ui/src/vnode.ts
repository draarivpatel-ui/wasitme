/**
 * The pure render output: a tree of plain objects. Every page is built as a VNode tree (testable in Node, no
 * browser), and dom.ts turns it into DOM with createElement / createElementNS / createTextNode / setAttribute only.
 * Text is always a string child (never markup). There is no style attribute and no event-handler attribute: styling
 * is by class only (the CSP forbids inline style), and interaction is a named `act` that main.ts wires up.
 */

export interface Act {
  /** A bridge action name (scanNow, showPage, selectAgent, addIntegration, …), or toggleSection, which main.ts
   *  handles in the page and never posts. */
  action: string;
  page?: string;
  agent?: string;
  /** For selectAgent: the agent's index in the decoded document (local switch even when the id can't be sent). */
  index?: number;
  /** For toggleSection: the disclosure's key ("verdict.details"). */
  section?: string;
  /** For addIntegration / removeIntegration: the install part (the bridge's IntegrationID raw value). */
  integration?: string;
  /** For setLaunchAtLogin / setDesktopPanel: the state the switch asks for (a JavaScript boolean, never a string). */
  enabled?: boolean;
}

export interface VNode {
  tag: string;
  svg?: true;
  attrs: { [name: string]: string };
  kids: Kid[];
  act?: Act;
}
export type Kid = VNode | string;
export type KidIn = Kid | null | undefined | false | KidIn[];

export interface Props {
  cls?: string | null | (string | false | null | undefined)[];
  attrs?: { [name: string]: string | number | boolean | null | undefined };
  act?: Act;
}

function flat(into: Kid[], kids: KidIn[]): Kid[] {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) flat(into, k);
    else if (typeof k === "string") { if (k !== "") into.push(k); }
    else into.push(k);
  }
  return into;
}

function attrsOf(p: Props | null | undefined): { [name: string]: string } {
  const out: { [name: string]: string } = {};
  if (!p) return out;
  if (p.cls) {
    const c = Array.isArray(p.cls) ? p.cls.filter((x): x is string => typeof x === "string" && x !== "").join(" ") : p.cls;
    if (c) out["class"] = c;
  }
  if (p.attrs) {
    for (const k of Object.keys(p.attrs)) {
      const v = p.attrs[k];
      if (v === null || v === undefined || v === false) continue;
      out[k] = v === true ? "" : String(v);
    }
  }
  return out;
}

/** An HTML element. */
export function h(tag: string, props?: Props | null, ...kids: KidIn[]): VNode {
  const v: VNode = { tag, attrs: attrsOf(props), kids: flat([], kids) };
  if (props?.act) v.act = props.act;
  return v;
}

/** An SVG element; numbers are rounded to 0.1 px so output is stable. */
export function s(tag: string, attrs?: { [name: string]: string | number | null | undefined } | null, ...kids: KidIn[]): VNode {
  const a: { [name: string]: string } = {};
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === null || v === undefined) continue;
    a[k] = typeof v === "number" ? String(Math.round(v * 10) / 10) : v;
  }
  return { tag, svg: true, attrs: a, kids: flat([], kids) };
}

/** All text in a tree, in document order (tests and accessible names). */
export function textOf(v: Kid): string {
  if (typeof v === "string") return v;
  return v.kids.map(textOf).join("");
}

/** Depth-first walk. */
export function walk(v: Kid, fn: (n: VNode, parents: VNode[]) => void, parents: VNode[] = []): void {
  if (typeof v === "string") return;
  fn(v, parents);
  const next = [...parents, v];
  for (const k of v.kids) walk(k, fn, next);
}
