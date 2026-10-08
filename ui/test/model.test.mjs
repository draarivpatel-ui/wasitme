// Node tests for the canvas's pure render model (ui/build, compiled by ui/scripts/build.mjs): every golden in
// contract/fixtures, decoded and rendered to a VNode tree for every lead variant, page, agent and chrome mode, with no
// browser. Run: node ui/scripts/build.mjs && node --test ui/test/model.test.mjs   (through scripts/dev/heavy.sh)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process"; // wasitme:allow-child_process -- test-only: runs repo scripts with a fixed argv
import { join } from "node:path";
import { cases, crowdedChanges, denseUpdates, PAGE_IDS, ROOT, UI } from "./fixtures.mjs";
import { realCsp } from "./cdp.mjs";

const B = join(UI, "build");
const { decodeSnapshot } = await import(join(B, "decode.js"));
const { renderApp, landingPage, MOD_CALLS, PLUGIN_CAN } = await import(join(B, "pages.js"));
const { forest, strip, badgeName, laneMarks, markWidth } = await import(join(B, "charts.js"));
const { clean, bound, isBridgeId } = await import(join(B, "sanitize.js"));
const { materialize, actKey } = await import(join(B, "dom.js"));
const { walk, textOf } = await import(join(B, "vnode.js"));
const { xs, num, fdate, fill } = await import(join(B, "format.js"));
const { countWords, knWords, shortVersions, eventLabel, shortLabel, bindingGate, metricName } = await import(join(B, "derive.js"));
const { decodeSettings } = await import(join(B, "view.js"));

const ALL = cases();
const byName = new Map(ALL.map((c) => [c.name, c]));
const tokens = JSON.parse(readFileSync(join(ROOT, "design/system/tokens.json"), "utf8"));
const BANNED = tokens.copy.banned.map((b) => ({ re: new RegExp(b.pattern, b.flags), except: b.except ?? null, why: b.why }));
// Every action a control may carry: the bridge actions (UX-V2 §10.1) and toggleSection, which main.ts keeps local.
const ACTIONS = new Set(["scanNow", "showPage", "selectAgent", "copyReport", "openMarkdown", "toggleSection", "addIntegration", "removeIntegration",
  "setLaunchAtLogin", "setDesktopPanel", "clearHistory", "uninstallAll", "updateApp", "revealDataFolder"]);
/** The setup changes and in-app actions a Settings control may post (each needs native to back it, §9.4). */
const SETUP_ACTIONS = new Set(["addIntegration", "removeIntegration", "setDesktopPanel", "clearHistory", "uninstallAll", "updateApp", "revealDataFolder"]);
const INTEGRATION_IDS = new Set(["app", "scan", "claude-plugin", "codex-plugin", "statusline"]);
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­؜​-‏‪-‮⁠-⁯﻿\u{e0000}-\u{e007f}]/u;

const decode = (c, extra = {}) => decodeSnapshot(c.doc, { nowMs: Date.parse(c.now), ...extra });
const ui = (c, page, more = {}) => ({ page, agent: 0, chrome: "full", nowMs: Date.parse(c.now), timeZone: "UTC", ...more });
function nodes(tree) { const out = []; walk(tree, (n, parents) => out.push({ n, parents })); return out; }
const allText = (tree) => { const t = []; walk(tree, (n) => { for (const k of n.kids) if (typeof k === "string") t.push(k); }); return t; };
const find = (tree, pred) => nodes(tree).filter(({ n }) => pred(n)).map((x) => x.n);
const cls = (n) => (n.attrs.class ?? "").split(" ");
/** The disclosure keys still closed in a tree. */
const closedKeys = (tree) => find(tree, (n) => n.act?.action === "toggleSection" && n.attrs["aria-expanded"] === "false").map((n) => n.act.section);
/** The same page with every disclosure open (the reader opened each one closed by default). */
function openAll(d, u) {
  const first = renderApp(d, u);
  return renderApp(d, { ...u, open: [...(u.open ?? []), ...closedKeys(first)] });
}
/** A Settings view as native sends it once wired (view.settings, UX-V2 §10.2). */
// What macos SettingsState.viewObject sends for a recorded install the installer answered for.
const WIRED = {
  settings: { version: "0.1.0", installed: true, answered: true, canClearHistory: true, integrations: [{ id: "app", state: "on" }, { id: "claude-plugin", state: "off" }, { id: "statusline", state: "own" },
    { id: "codex-plugin", state: "unavailable", why: "agent_missing" }, { id: "scan", state: "on" }], desktopPanel: false, launchAtLogin: true,
  update: { available: false, why: "no_release" }, busy: null },
  launchAtLogin: "off",
};

// ---------------------------------------------------------------------------------------------------------------
test("the design tokens module is generated from design/system and current", () => {
  const r = spawnSync(process.execPath, [join(UI, "scripts/gen.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("every golden decodes exactly as contract/fixtures/manifest.json says (display rules)", () => {
  assert.equal(ALL.length, 34);
  for (const c of ALL) {
    const d = decode(c);
    const e = c.expect;
    assert.equal(d.display, e.display, `${c.name}: display`);
    if (e.display === "mismatch" || e.display === "refused") { assert.equal(d.agents.length, 0, `${c.name}: nothing decoded`); continue; }
    assert.equal(d.scanFailed, e.scanFailed, `${c.name}: scanFailed`);
    assert.equal(d.lead, e.lead, `${c.name}: lead`);
    assert.equal(d.demo, e.demo, `${c.name}: demo`);
    assert.equal(d.agents.length, e.agents.length, `${c.name}: agents`);
    e.agents.forEach((ea, i) => {
      const a = d.agents[i];
      assert.equal(a.state, ea.state, `${c.name}[${i}] state`);
      assert.equal(a.reason, ea.reason, `${c.name}[${i}] reason`);
      assert.equal(a.pending, ea.pending, `${c.name}[${i}] pending`);
      assert.equal(a.calibrated, ea.calibrated, `${c.name}[${i}] calibrated`);
      assert.equal(d.display === "stale" ? "stale" : a.state, ea.display, `${c.name}[${i}] display`);
    });
    if (e.firstEventSide) assert.equal(d.agents[0].timeline.at(-1).side, e.firstEventSide, `${c.name}: newest event side`);
  }
});

test("the native app's own display decision wins over the page's clock", () => {
  const c = byName.get("snapshot-insufficient-timeline");
  const late = Date.parse("2026-10-05T09:00:00Z");
  assert.equal(decodeSnapshot(c.doc, { nowMs: late }).display, "stale");
  assert.equal(decodeSnapshot(c.doc, { nowMs: late, viewDocument: "ok" }).display, "ok");
  for (const d of ["loading", "notSetUp", "unreadable", "mismatch", "refused"]) {
    const doc = decodeSnapshot(c.doc, { nowMs: late, viewDocument: d });
    assert.equal(doc.display, d); assert.equal(doc.agents.length, 0);
  }
  assert.equal(decodeSnapshot(null, { nowMs: late }).display, "loading");
  assert.equal(decodeSnapshot("not json object", { nowMs: late }).display, "mismatch");
  assert.equal(decodeSnapshot({ ...c.doc, schema: "wasitme.snapshot/1.1" }, { nowMs: late }).display, "mismatch", "minor ids are reserved (D45)");
  assert.equal(decodeSnapshot({ ...c.doc, privacy: { containsText: "false" } }, { nowMs: late }).display, "refused");
});

test("a __proto__ key or a polluted prototype never supplies a value", () => {
  const c = byName.get("snapshot-insufficient-timeline");
  const json = JSON.stringify(c.doc).replace('"agents":[{', '"agents":[{"__proto__":{"state":"agent","headline":"INJECTED"},');
  const parsed = JSON.parse(json);
  const d = decodeSnapshot(parsed, { nowMs: Date.parse(c.now) });
  assert.equal(d.agents[0].state, "insufficient");
  const proto = Object.create({ schema: "wasitme.snapshot/1", privacy: { containsText: false } });
  assert.equal(decodeSnapshot(proto, { nowMs: 0 }).display, "mismatch");
});

// ---------------------------------------------------------------------------------------------------------------
const RENDERS = [];
for (const c of ALL) for (const lead of ["timeline", "verdict"]) {
  const base = c.doc && typeof c.doc === "object" && !Array.isArray(c.doc) ? { ...c.doc, lead } : c.doc;
  const d = decodeSnapshot(base, { nowMs: Date.parse(c.now) });
  const agents = Math.max(1, d.agents.length);
  for (const page of [landingPage(d), ...PAGE_IDS]) for (let agent = 0; agent < agents; agent++) for (const chrome of ["full", "content"]) {
    const u = ui(c, page, { agent, chrome });
    RENDERS.push({ c, lead, d, page, agent, chrome, open: false, tree: renderApp(d, u) });
    // every disclosure open (UX-V2 §14.2: every check below holds with the evidence shown), and Settings as native sends it
    const settings = page === "settings" && chrome === "content" ? decodeSettings(WIRED) : undefined;
    RENDERS.push({ c, lead, d, page, agent, chrome, open: true, tree: openAll(d, { ...u, ...(settings ? { settings } : {}) }) });
  }
}

test("every golden renders on every page, lead, agent and chrome mode without throwing", () => {
  assert.ok(RENDERS.length > 1800, `${RENDERS.length} renders`);
});

test("the tree carries no markup, style, handler or URL attribute, and only plain, cleaned text", () => {
  for (const r of RENDERS) {
    for (const { n } of nodes(r.tree)) {
      assert.doesNotMatch(n.tag, /^(script|style|iframe|object|embed|link|meta|base|form|a|img|foreignObject|use|image)$/i, `${r.c.name}: <${n.tag}>`);
      for (const k of Object.keys(n.attrs)) assert.doesNotMatch(k, /^(on|style$|href$|src$|srcdoc$|xlink:)/i, `${r.c.name}: attribute ${k}`);
      for (const v of Object.values(n.attrs)) assert.doesNotMatch(v, INVISIBLE, `${r.c.name}: invisible char in an attribute`);
      if (n.act) {
        assert.ok(ACTIONS.has(n.act.action), `${r.c.name}: action ${n.act.action}`);
        if (n.act.agent !== undefined) assert.ok(isBridgeId(n.act.agent), `${r.c.name}: agent id sent back must be bridge-safe`);
        if (n.act.action === "toggleSection") assert.match(n.act.section ?? "", /^[a-z]+\.[A-Za-z]+$/, `${r.c.name}: a disclosure key`);
        if (/Integration$/.test(n.act.action)) assert.ok(INTEGRATION_IDS.has(n.act.integration), `${r.c.name}: integration id ${n.act.integration}`);
        if (/^set/.test(n.act.action)) assert.equal(typeof n.act.enabled, "boolean", `${r.c.name}: a switch asks with a boolean`);
      }
    }
    for (const t of allText(r.tree)) assert.doesNotMatch(t, INVISIBLE, `${r.c.name}/${r.page}: invisible or control char in text`);
  }
});

test("accessibility: one main, labelled nav, one h1, no skipped heading level, unique ids, named buttons", () => {
  for (const r of RENDERS) {
    const all = nodes(r.tree);
    const mains = all.filter(({ n }) => n.tag === "main");
    assert.equal(mains.length, 1, `${r.c.name}/${r.page}: one main`);
    assert.ok(mains[0].n.attrs["aria-label"], "main is labelled");
    const navs = all.filter(({ n }) => n.tag === "nav");
    assert.equal(navs.length, r.chrome === "full" ? 1 : 0, `${r.c.name}/${r.page}/${r.chrome}: nav`);
    if (navs.length) assert.ok(navs[0].n.attrs["aria-label"]);
    const hs = all.filter(({ n }) => /^h[1-6]$/.test(n.tag)).map(({ n }) => Number(n.tag[1]));
    assert.equal(hs.filter((x) => x === 1).length, 1, `${r.c.name}/${r.page}: exactly one h1 (${hs.join(",")})`);
    assert.equal(hs[0], 1, `${r.c.name}/${r.page}: the first heading is the h1`);
    for (let i = 1; i < hs.length; i++) assert.ok(hs[i] <= hs[i - 1] + 1, `${r.c.name}/${r.page}: heading skips ${hs[i - 1]}→${hs[i]}`);
    const ids = all.map(({ n }) => n.attrs.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, "unique ids");
    for (const { n } of all.filter(({ n }) => n.tag === "button")) assert.ok(textOf(n).trim() || n.attrs["aria-label"], `${r.c.name}: unnamed button`);
    for (const { n } of all.filter(({ n }) => n.tag === "li" && cls(n).includes("on"))) {
      const b = n.kids.find((k) => typeof k !== "string" && k.tag === "button");
      assert.equal(b.attrs["aria-current"], "page");
    }
  }
});

test("accessibility: every chart is either aria-hidden or an image with a summary and a full text description", () => {
  let charts = 0;
  for (const r of RENDERS) {
    const all = nodes(r.tree);
    const ids = new Map(all.filter(({ n }) => n.attrs.id).map(({ n }) => [n.attrs.id, n]));
    for (const { n, parents } of all.filter(({ n }) => n.tag === "svg")) {
      const hidden = n.attrs["aria-hidden"] === "true" || parents.some((p) => p.attrs["aria-hidden"] === "true");
      if (hidden) continue;
      charts++;
      assert.equal(n.attrs.role, "img", `${r.c.name}/${r.page}: a visible svg needs role=img`);
      assert.ok(n.attrs["aria-label"]?.length > 10, "summary label");
      const desc = ids.get(n.attrs["aria-describedby"]);
      assert.ok(desc && textOf(desc).length > 5, "describedby points at a text description");
    }
  }
  assert.ok(charts > 100, `${charts} charts checked`);
});

test("copy: no banned word in anything the canvas shows (tokens.json copy.banned; hostile golden excluded)", () => {
  for (const r of RENDERS) {
    if (r.c.name.includes("hostile")) continue;
    const text = allText(r.tree).join("\n");
    for (const b of BANNED) {
      const t = b.except ? text.split(b.except).join(" ") : text;
      assert.doesNotMatch(t, b.re, `${r.c.name}/${r.page}: banned copy (${b.why})`);
    }
  }
});

test("mismatch and refused documents show nothing from the document", () => {
  for (const r of RENDERS.filter((x) => x.d.display === "mismatch" || x.d.display === "refused")) {
    const text = allText(r.tree).join(" ");
    assert.doesNotMatch(text, /effort change|Your numbers moved|2\.1\.2/, `${r.c.name}: leaked document text`);
    assert.ok(/Update needed|Not shown/.test(text), `${r.c.name}: says why`);
  }
});

test("document-level pages show their own app-state chip and glyph, never a finding's (design tokens appStates)", () => {
  const want = { loading: "loading", notSetUp: "notSetUp", empty: "empty", unreadable: "unreadable", mismatch: "updateNeeded", refused: "refused" };
  const seen = new Set();
  const late = Date.parse(ALL[0].now);
  const docs = [...RENDERS.filter((r) => r.d.display in want && r.page === "verdict").map((r) => [r.c.name, r.d, r.c]),
    ...["loading", "notSetUp", "unreadable"].map((v) => [`blank ${v}`, decodeSnapshot(null, { nowMs: late, viewDocument: v }), ALL[0]])];
  for (const [name, d, c] of docs) {
    const tree = renderApp(d, ui(c, "verdict"));
    const chips = find(tree, (n) => cls(n).includes("chip"));
    assert.equal(chips.length, 1, `${name}: one chip`);
    assert.ok(cls(chips[0]).includes("chip--app"), `${name}: the app-state chip, not a finding chip`);
    const label = allText(chips[0]).join("");
    assert.equal(label.replace(/’/g, "'"), tokens.appStates[want[d.display]].label, `${name}: chip words are the app state's label`);
    const svg = find(chips[0], (n) => n.tag === "svg")[0];
    const file = readFileSync(join(ROOT, "design/system", tokens.appStates[want[d.display]].files["16"]), "utf8");
    const rects = find(svg, (n) => n.tag === "rect").map((n) => `${n.attrs.x},${n.attrs.y},${n.attrs.width},${n.attrs.height}`);
    const fileRects = [...file.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)].map((m) => m.slice(1).join(","));
    assert.deepEqual(rects, fileRects, `${name}: draws glyphs/app-*-16.svg`);
    seen.add(d.display);
  }
  assert.deepEqual([...seen].sort(), Object.keys(want).sort(), "every document-level display is covered");
});

test("the demo banner shows only when demo is true, at the top of every page", () => {
  for (const r of RENDERS) {
    const has = allText(r.tree).some((t) => /demo data/i.test(t));
    const want = r.d.demo === true && r.d.display !== "mismatch" && r.d.display !== "refused";
    assert.equal(has, want, `${r.c.name}/${r.page}: demo banner`);
    const page = find(r.tree, (n) => cls(n).includes("page"))[0];
    const first = page.kids.find((k) => typeof k !== "string");
    if (want) assert.ok(cls(first).includes("banner"), `${r.c.name}/${r.page}: the banner leads the page`);
  }
});

test("content chrome (the Mac app): no sidebar, window buttons, top bar or stamp; the full chrome draws no window buttons either", () => {
  for (const r of RENDERS) {
    for (const k of ["topbar", "stamp", "lights"]) assert.equal(find(r.tree, (n) => cls(n).includes(k)).length, 0, `${r.c.name}/${r.page}/${r.chrome}: .${k}`);
    assert.equal(find(r.tree, (n) => cls(n).includes("sidebar")).length, r.chrome === "full" ? 1 : 0, `${r.c.name}/${r.page}/${r.chrome}: sidebar`);
    // the toolbar owns these in the app; nothing in the page repeats them
    for (const a of ["scanNow", "copyReport", "openMarkdown"]) assert.ok(!find(r.tree, (n) => n.act?.action === a).length, `${r.c.name}/${r.page}: ${a} in the page`);
  }
});

test("disclosures (UX-V2 §5): a button with aria-expanded and aria-controls; the region is always there, hidden and empty when closed", () => {
  let checked = 0;
  for (const r of RENDERS) {
    const all = nodes(r.tree).map(({ n }) => n);
    const byId = new Map(all.filter((n) => n.attrs.id).map((n) => [n.attrs.id, n]));
    for (const b of all.filter((n) => n.act?.action === "toggleSection")) {
      checked++;
      assert.equal(b.tag, "button");
      assert.ok(["true", "false"].includes(b.attrs["aria-expanded"]), "aria-expanded");
      const region = byId.get(b.attrs["aria-controls"]);
      assert.ok(region, `${r.c.name}/${r.page}: aria-controls points at the region`);
      assert.equal(region.attrs.role, "region");
      assert.equal(region.attrs["aria-labelledby"], b.attrs.id, "the region is named by its button");
      const open = b.attrs["aria-expanded"] === "true";
      assert.equal(region.attrs.hidden !== undefined, !open, `${r.c.name}/${r.page}: hidden iff closed`);
      if (!open) assert.equal(region.kids.length, 0, `${r.c.name}/${r.page}: a closed region renders nothing`);
      else assert.ok(region.kids.length > 0, `${r.c.name}/${r.page}: an open region shows its contents`);
      // drawn chevron, never a text character
      assert.doesNotMatch(textOf(b), /[▸▾▶▼›]/);
    }
    if (r.open) assert.equal(closedKeys(r.tree).length, 0, `${r.c.name}/${r.page}: every disclosure opened`);
  }
  assert.ok(checked > 1500, `${checked} disclosures checked`);
});

test("disclosure defaults: only Finding → Details opens by itself, and only for an agent-side finding (D44 5b)", () => {
  for (const r of RENDERS.filter((x) => !x.open)) {
    const opened = find(r.tree, (n) => n.act?.action === "toggleSection" && n.attrs["aria-expanded"] === "true").map((n) => n.act.section);
    const a = r.d.agents[r.agent];
    const want = r.page === "verdict" && r.d.display === "ok" && a?.state === "agent" ? ["verdict.details"] : [];
    assert.deepEqual(opened, want, `${r.c.name}/${r.page}`);
  }
  // a reader's toggle flips the default either way
  const c = byName.get("snapshot-agent-by_elimination"), d = decode(c);
  const closed = renderApp(d, ui(c, "verdict", { open: ["verdict.details"] }));
  assert.equal(find(closed, (n) => n.act?.section === "verdict.details")[0].attrs["aria-expanded"], "false");
  assert.notEqual(actKey({ action: "toggleSection", section: "verdict.details" }), actKey({ action: "toggleSection", section: "verdict.daily" }), "each disclosure keeps its own focus key");
});

test("no copy placeholder is ever left unfilled", () => {
  for (const r of RENDERS) {
    if (r.c.name.includes("hostile")) continue;
    for (const t of allText(r.tree)) assert.doesNotMatch(t, /\{[A-Za-z]+\}/, `${r.c.name}/${r.page}: "${t.slice(0, 60)}"`);
    for (const { n } of nodes(r.tree)) for (const v of Object.values(n.attrs)) assert.doesNotMatch(v, /\{[A-Za-z]+\}/, `${r.c.name}/${r.page}: attribute "${v.slice(0, 60)}"`);
  }
  assert.equal(fill("a {x} b {y}", { x: 1 }), "a 1 b {y}", "a missing value stays visible");
});

test("lead variants land on the right page (D28)", () => {
  const c = byName.get("snapshot-insufficient-timeline");
  assert.equal(landingPage(decode(c)), "timeline");
  assert.equal(landingPage(decode(byName.get("snapshot-you-and-codex"))), "verdict");
});


test("Next to unlock: a date only when a document carries one (inline fixture; the v1 engine sends none, D66)", () => {
  // The shared goldens follow the v1 engine (no etaDate). An engine that shows dates again (D64(c)) would send one; the
  // canvas keeps that branch, held here on a modified copy, and still never shows a date under notAtCurrentPace.
  const c = byName.get("snapshot-insufficient-timeline");
  const withDate = (p) => {
    const doc = structuredClone(c.doc);
    Object.assign(doc.agents[0].progress, p);
    return renderApp(decodeSnapshot(doc, { nowMs: Date.parse(c.now) }), ui(c, "verdict"));
  };
  const dated = allText(withDate({ etaDate: "2026-10-10", notAtCurrentPace: false })).join(" ");
  assert.ok(dated.includes("about 6 days (Oct 10)"), dated);
  assert.ok(!dated.includes("No date yet"));
  const notAtPace = allText(withDate({ etaDate: "2026-10-10", notAtCurrentPace: true })).join(" ");
  assert.ok(notAtPace.includes("No date yet: it depends on how your sessions go."));
  assert.ok(!/Oct 10|current pace|At your pace/.test(notAtPace), notAtPace);
});

test("Next to unlock shows the binding gate in its own unit, never a met count against another target (inline fixtures)", () => {
  // The live defect: thousands of events, too few session-days. The events pair is met (3,150 of 10); the session-days
  // pair (7 of 10) is what keeps the indicator locked, so that is the counter, the bar and the ledger cell.
  const c = byName.get("snapshot-insufficient-timeline");
  const withUnlock = (unlock) => {
    const doc = structuredClone(c.doc);
    doc.agents[0].progress.unlock = unlock;
    const d = decodeSnapshot(doc, { nowMs: Date.parse(c.now) });
    return { d, shown: renderApp(d, ui(c, "verdict")), open: openAll(d, ui(c, "verdict")) };
  };
  const gate = (have, need) => [{ metric: "readsPerEdit", family: "research", have, need }];
  const N = { events: 40, sessions: 5, sessionDays: 10 };

  const days = withUnlock(gate({ events: 3150, sessions: 7, sessionDays: 7 }, { ...N, events: 10 }));
  assert.deepEqual(bindingGate(days.d.agents[0].progress.unlock[0]), { unit: "sessionDays", have: 7, need: 10, noun: "session-days" });
  const shown = allText(days.shown).join(" ");
  assert.ok(shown.includes("7 of 10 session-days"), shown);
  assert.ok(!/3,150 of|of 10 edits/.test(shown), "never the met events pair");
  const cells = find(days.shown, (n) => cls(n).includes("cells"))[0];
  assert.equal(cells.kids.length, 10, "the bar has the binding pair's 10 cells");
  assert.equal(cells.kids.filter((k) => !cls(k).includes("off")).length, 7, "7 of them on");
  const open = allText(days.open).join(" ");
  assert.ok(open.includes("7 of 10 session-days needed"), "the ledger cell names the same pair");
  assert.ok(open.includes("Each window needs at least 10 session-days."), "the detail says what is counted, in that unit");
  assert.ok(!open.includes("in the recent window."), "no window the document does not name");

  // The events pair binding (31 of 40 < 4 of 5 < 9 of 10): the shared golden's case, unchanged.
  const edits = allText(withUnlock(gate({ events: 31, sessions: 4, sessionDays: 9 }, N)).open).join(" ");
  assert.ok(edits.includes("31 of 40 edits") && edits.includes("Each window needs at least 40 edits."), edits);

  // Every pair met (only one session dominating): no count and no bar, the reason instead.
  const share = withUnlock(gate({ events: 2100, sessions: 43, sessionDays: 56 }, N));
  const shareText = allText(share.open).join(" ");
  assert.ok(!/\d of \d/.test(shareText.replace(/\d+ of \d+ days/g, "")), "no 'N of M' counter");
  assert.equal(find(share.shown, (n) => cls(n).includes("cells")).length, 0, "no bar");
  assert.ok(find(share.shown, (n) => cls(n).includes("next"))[0], "the Next to unlock block still shows");

  // A field the document left out is unknown, never 0 of N.
  const partial = withUnlock(gate({ events: 3150, sessionDays: 7 }, { events: 10, sessions: 5, sessionDays: 10 }));
  const partialText = allText(partial.shown).join(" ");
  assert.ok(partialText.includes("7 of 10 session-days") && !partialText.includes("0 of 5"), partialText);
});

test("Next to unlock and the ledger name every indicator by its label, never its id, with or without its own row (inline fixtures)", () => {
  // The Codex demo's defect: its unlock item named an indicator the document had no metric row for, and the Finding
  // page printed the id ("toolErrors 8 of 10 session-days"). Labels are the engine's own (engine/src/words/names.ts).
  const names = readFileSync(join(ROOT, "engine/src/words/names.ts"), "utf8");
  const LABEL = new Map([...names.matchAll(/^\s*(\w+): \{ label: "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const build = readFileSync(join(ROOT, "engine/src/words/build.ts"), "utf8");
  const ids = [...(/export const SNAPSHOT_METRICS\b[^=]*=\s*\[([^\]]*)\]/.exec(build)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8 && ids.includes("toolErrorsNonCmd"), ids.join(" "));
  const c = byName.get("snapshot-insufficient-timeline");
  // An id this version does not know is shown by its words, never as the id itself.
  const cases = [...ids.map((id) => [id, LABEL.get(id)]), ["fooBarBaz", "Foo bar baz"]];
  for (const [id, label] of cases) {
    assert.ok(label, `${id}: a label in names.ts`);
    for (const row of ["own", "unlabelled", "none"]) {
      const doc = structuredClone(c.doc);
      const a = doc.agents[0];
      a.progress.unlock = [{ metric: id, family: "errors", have: { events: 10, sessions: 6, sessionDays: 8 }, need: { events: 10, sessions: 5, sessionDays: 10 } }];
      // "own" and "unlabelled" need the indicator's row: the golden lacks some (toolErrorsNonCmd), so one is added.
      if (row !== "none" && !a.metrics.some((m) => m.id === id)) a.metrics.push({ ...structuredClone(a.metrics.find((m) => m.id === "readsPerEdit")), id, label });
      if (row === "none") a.metrics = a.metrics.filter((m) => m.id !== id);
      if (row === "unlabelled") for (const m of a.metrics) if (m.id === id) delete m.label;
      const d = decodeSnapshot(doc, { nowMs: Date.parse(c.now) });
      assert.equal(d.agents[0].metrics.some((m) => m.id === id), row !== "none", `${id}/${row}: the row is decoded as set up`);
      const shown = renderApp(d, ui(c, "verdict"));
      const next = find(shown, (n) => cls(n).includes("next"))[0];
      assert.ok(next, `${id}/${row}: the Next to unlock block`);
      const lbl = find(next, (n) => cls(n).includes("lbl")).map(textOf);
      assert.deepEqual(lbl, [label], `${id}/${row}: Next to unlock names "${label}"`);
      // A one-word id ("pushback") is also an English word in its own label; the label check above covers it.
      if (!/[A-Z]/.test(id)) continue;
      for (const page of ["verdict", "compare"]) {
        const text = allText(openAll(d, ui(c, page))).join(" ");
        assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `${id}/${row}/${page}: the raw id reached the page: ${text}`);
      }
    }
  }
  // Words longer than a label's 40 characters are no name at all: "Indicator", as the engine and the app say.
  assert.equal(metricName("aA".repeat(16)), "Indicator");
  assert.equal(metricName("toolErrors"), "Tool errors");
});

// ---------------------------------------------------------------------------------------------------------------
const render = (name, page, more = {}) => { const c = byName.get(name); const d = decode(c); return { d, tree: renderApp(d, ui(c, page, more)) }; };
/** The same, with every disclosure open: what a reader sees after opening each one. */
const renderOpen = (name, page, more = {}) => { const c = byName.get(name); const d = decode(c); return { d, tree: openAll(d, ui(c, page, more)) }; };
const h1 = (tree) => textOf(find(tree, (n) => n.tag === "h1")[0]);

test("Finding (too early to tell): title, deck and chart first; the note and the ledger one click away; no projected date (D66)", () => {
  const { d, tree } = render("snapshot-insufficient-timeline", "verdict");
  const a = d.agents[0];
  assert.equal(h1(tree), "Too early to tell.");
  assert.equal(textOf(find(tree, (n) => cls(n).includes("t-deck"))[0]), a.headline);
  const shown = allText(tree).join(" ");
  // visible by default: the answer, the noise band above the strip (AGENTS.md rule 4), the unlock gate and its no-date line
  const w = a.strip.window;
  for (const s of ["Next to unlock", "31 of 40 edits", "No date yet: it depends on how your sessions go.", `×${w.ratio.toFixed(2)}`,
    `range ×${w.lo.toFixed(2)} to ×${w.hi.toFixed(2)}`, `changes under ${xs(w.mde)} wouldn’t show`]) assert.ok(shown.includes(s), s);
  assert.ok(!shown.includes(a.because), "the note sits in Details (D67 role kept, §8.1)");
  assert.ok(!/At your pace|current pace|Oct 10/.test(shown), "no date and no pace claim from the v1 golden");
  // one click away: the note, the ledger with every count and range, the confidence line
  const open = renderOpen("snapshot-insufficient-timeline", "verdict").tree;
  assert.equal(textOf(find(open, (n) => cls(n).includes("because"))[0]), a.because);
  const text = allText(open).join(" ");
  for (const s of ["31 of 40 edits needed", "No detectable change", "×0.75", "×0.42–×1.33", a.confidence]) assert.ok(text.includes(s), s);
  assert.equal(find(tree, (n) => n.tag === "line" && n.attrs.class === "c-axis-dash").length, 1, "dashed case line while too early (DESIGN.md: the rule is dashed while too early to tell)");
  assert.equal(find(render("snapshot-you-and-codex", "verdict").tree, (n) => n.attrs.class === "c-axis-dash").length, 0, "a solid case line once there is a finding");
  const svg = find(tree, (n) => n.tag === "svg" && n.attrs.role === "img")[0];
  const covered = a.strip.days.filter((x) => x.d >= "2026-09-06" && x.d <= "2026-10-03");
  const k = covered.reduce((s, x) => s + x.k, 0), n = covered.reduce((s, x) => s + x.n, 0);
  const marked = a.timeline.filter((e) => e.marker && e.day >= "2026-09-06" && e.day <= "2026-10-03").length;
  const label = a.metrics.find((m) => m.id === a.strip.metric).label;
  assert.equal(svg.attrs["aria-label"], `${label} per day, Sep 6 to Oct 3: ${num(k)} errors in ${num(n)} tool calls; ${marked} changes marked`);
  const ticks = find(svg, (x) => x.attrs.class === "c-tick").length;
  assert.equal(ticks, k, "one tick per event");
  const lowN = covered.filter((x) => x.n > 0 && x.n < 100 && x.k > 0);
  const half = find(svg, (x) => x.attrs.class === "c-tick" && Number(x.attrs.width) === 7).length;
  assert.equal(half, lowN.reduce((s, x) => s + x.k, 0), "narrow days (< 100 calls) are drawn half width");
  const dashes = find(svg, (x) => x.tag === "text" && x.kids[0] === "–").length;
  assert.equal(dashes, 0, "days outside the engine's strip are blank, never shown as 'no sessions'");
});

test("your side: the change it lines up with is tagged, moved ratios are canary-tinted, the disclaimer closes the visible block", () => {
  const { tree: shown } = render("snapshot-you-and-codex", "verdict");
  assert.equal(h1(shown), "Your side changed.");
  // the disclaimer is the last thing before the disclosures, so a screenshot of the default view always carries it
  const page = find(shown, (n) => cls(n).includes("page"))[0];
  const flat = nodes(page).map(({ n }) => n);
  const disc = flat.findIndex((n) => cls(n).includes("disclaimer")), firstDisc = flat.findIndex((n) => cls(n).includes("disc-block"));
  assert.ok(disc > 0 && disc < firstDisc, "disclaimer closes the visible block");
  assert.equal(textOf(flat[disc]), "These indicators don't measure answer quality. Evidence, not proof.");
  const { tree } = renderOpen("snapshot-you-and-codex", "verdict");
  const text = allText(tree).join(" ");
  assert.ok(text.includes("lines up with the shift"));
  assert.ok(text.includes("Moved, more") && text.includes("Moved, fewer"));
  const tag = find(tree, (n) => cls(n).includes("qtag") && textOf(n) === "lines up with the shift");
  assert.ok(tag.length && tag.every((n) => cls(n).includes("qtag--you")), "the tag carries your side's tint");
  const moved = find(tree, (n) => n.tag === "td" && cls(n).includes("moved"));
  assert.equal(moved.length, 3);
  assert.ok(moved.every((n) => !cls(n).includes("agent") && !cls(n).includes("neutral")), "canary tint for your side");
});

test("agent side: What was checked shows by default (D44 5b), blue tint, the version-boundary candidate", () => {
  const { tree: shown } = render("snapshot-agent-by_elimination", "verdict");
  assert.equal(h1(shown), "The agent changed.");
  const visible = allText(shown).join(" ");
  for (const s of ["What was checked", "Your setup", "Workload", "The shift", "Sample", "Not visible", "ruled out", "checked at the version boundary"]) assert.ok(visible.includes(s), s);
  const { tree } = renderOpen("snapshot-agent-by_elimination", "verdict");
  const moved = find(tree, (n) => n.tag === "td" && cls(n).includes("moved"));
  assert.ok(moved.length >= 2 && moved.every((n) => cls(n).includes("agent")));
});

test("can't tell which: a moved ratio gets the neutral tint, never a side's colour", () => {
  const { tree } = renderOpen("glance-unclear-verdict", "verdict");
  assert.equal(h1(tree), "Can’t tell which.");
  const moved = find(tree, (n) => n.tag === "td" && cls(n).includes("moved"));
  assert.ok(moved.length && moved.every((n) => cls(n).includes("neutral")));
});

test("Codex while calibration is pending: Timeline only, no ledger, an events-only strip", () => {
  const { tree } = renderOpen("snapshot-you-and-codex", "verdict", { agent: 1 });
  assert.equal(h1(tree), "Timeline only, for now.");
  const text = allText(tree).join(" ");
  assert.ok(text.includes("Before Codex can be compared") && text.includes("What changed"));
  assert.ok(!text.includes("What wasitme compared"));
  const svg = find(tree, (n) => n.tag === "svg" && n.attrs.role === "img")[0];
  assert.match(svg.attrs["aria-label"], /^changes on each side/, "an events-only strip");
  assert.equal(find(svg, (n) => n.attrs.class === "c-tick").length, 0);
});

test("stale: the last known state is shown dimmed beside the stale mark, never as current", () => {
  const { tree } = render("glance-stale", "verdict");
  assert.equal(h1(tree), "Out of date.");
  const text = allText(tree).join(" ");
  assert.ok(text.includes("Last known: Your side") && text.includes("This is the last known state, not a current one."));
  assert.ok(find(tree, (n) => cls(n).includes("lastknown")).length >= 1);
  assert.ok(!find(tree, (n) => cls(n).includes("chip--you")).length, "no current 'Your side' chip");
});

test("pending, scan failed, empty and hostile documents", () => {
  assert.ok(allText(render("glance-pending", "verdict").tree).join(" ").includes("Holding this state until the next check agrees."));
  assert.ok(allText(render("glance-scan-failed", "verdict").tree).join(" ").includes("Last scan failed (permission denied)."));
  const empty = render("snapshot-empty", "verdict").tree;
  assert.equal(h1(empty), "No agents yet.");
  const { d, tree } = render("glance-hostile-labels", "verdict");
  assert.equal(d.agents[0].id, "claude-code");
  assert.equal(d.agents[0].bridgeId, null, "a hostile id is never sent back to native");
  const text = allText(tree).join("\n");
  assert.doesNotMatch(text, /\u001b|‮|​/);
  assert.ok(text.includes("<script>alert(1)</script>"), "markup in engine text stays plain text");
  const seg = find(tree, (n) => n.act?.action === "selectAgent")[0];
  assert.equal(seg.act.agent, undefined);
});

test("timeline-led page: All changes lists every change newest first, grouped by window, one badge and at most one tag each", () => {
  const { d, tree: shown } = render("snapshot-insufficient-timeline", "timeline");
  assert.equal(h1(shown), "Timeline");
  assert.ok(allText(shown).join(" ").includes("See the finding"));
  const { tree } = renderOpen("snapshot-insufficient-timeline", "timeline");
  const a = d.agents[0];
  const rows = find(tree, (n) => cls(n).includes("chg"));
  assert.equal(rows.length, a.timeline.length);
  assert.equal(textOf(rows[0].kids[0]), "Oct 1");
  const days = rows.map((r) => textOf(r.kids[0]));
  assert.deepEqual(days, [...a.timeline].reverse().map((e) => fdate(e.day)), "newest first");
  for (const r of rows) assert.ok(find(r, (n) => cls(n).includes("qtag")).length <= 1, "at most one tag per row");
  const text = allText(tree).join(" ");
  assert.ok(text.includes("Recent window · Sep 20 – Oct 3") && text.includes("Before · Aug 23 – Sep 19"), "grouped by window");
  assert.doesNotMatch(text, /\(update\)/, "no “(update)” on routine rows (report item 4)");
});

test("short versions (UX-V2 §7.2): the table, and the full label stays in the badge's name", () => {
  const cases = [
    ["0.144.0-alpha.4", "0.145.0-alpha.18", "0.144", "0.145", true], ["0.142.5", "0.144.0-alpha.4", "0.142", "0.144", true],
    ["2.1.274", "2.1.277", "2.1.274", "2.1.277", false], ["0.158", "0.160", "0.158", "0.160", false],
    ["0.145.0-alpha.17", "0.145.0-alpha.18", "0.145.0-alpha.17", "0.145.0-alpha.18", true], ["1.2", "2.0.1", "1.2", "2.0", false],
  ];
  for (const [from, to, sf, st, pre] of cases) assert.deepEqual(shortVersions(from, to), { from: sf, to: st, preRelease: pre }, `${from} → ${to}`);
  assert.equal(shortVersions("gpt-6", "gpt-6-luna"), null, "model names are not versions");
  const ev = { id: "x", t: "", day: "2026-10-01", kind: "version", side: "agent", strength: "routine", provenance: null, label: "Codex 0.144.0-alpha.4 → 0.145.0-alpha.18", from: "0.144.0-alpha.4", to: "0.145.0-alpha.18", isNew: false, marker: "B" };
  assert.deepEqual(eventLabel(ev), { text: "Codex 0.144 → 0.145", preRelease: true });
  assert.equal(shortLabel(ev), "0.145", "the chart shows only the new version, short");
  assert.equal(badgeName(ev, "Codex"), "Codex change B, Oct 1: Codex 0.144.0-alpha.4 → 0.145.0-alpha.18", "the name keeps the engine's full label");
  assert.deepEqual(eventLabel({ ...ev, kind: "model", label: "gpt-6 → gpt-6-luna", from: "gpt-6", to: "gpt-6-luna" }), { text: "gpt-6 → gpt-6-luna", preRelease: false }, "anything else verbatim");
  // every badge on every page is named with an event's full engine label
  let badges = 0;
  for (const r of RENDERS.filter((x) => !x.c.name.includes("hostile") && x.d.agents.length)) {
    const labels = new Set(r.d.agents.flatMap((a) => a.timeline.map((e) => e.label)));
    for (const n of find(r.tree, (x) => cls(x).includes("bdg"))) {
      badges++;
      const name = n.attrs["aria-label"];
      assert.equal(n.attrs.title, name, "the hover tip says the same");
      assert.ok([...labels].some((l) => name.endsWith(`: ${l}`)), `${r.c.name}/${r.page}: "${name}" carries a full label`);
    }
  }
  assert.ok(badges > 300, `${badges} badges checked`);
});

test("forest plot: shared log axis ×0.25–×8, open arrowheads past the axis, hatched too-small zone, filled vs open dot", () => {
  const f = forest({ ratio: 2.4, range: [0.2, 9.5], mde: 2, moved: true }, 220);
  assert.equal(find(f, (n) => n.attrs.class === "c-range-over").length, 2);
  assert.equal(find(f, (n) => n.attrs.class === "c-est").length, 1);
  assert.ok(find(f, (n) => n.attrs.class === "c-mde-hatch").length > 3);
  const one = find(f, (n) => n.attrs.class === "c-one")[0];
  assert.equal(Number(one.attrs.x1), Math.round((Math.log(1 / 0.25) / Math.log(32)) * 220 * 10) / 10);
  const g = forest({ ratio: 1.04, range: [0.62, 1.73], mde: 1.9, moved: false }, 220);
  assert.equal(find(g, (n) => n.attrs.class === "c-range-over").length, 0);
  assert.equal(find(g, (n) => n.attrs.class === "c-est-open").length, 1);
  assert.equal(f.attrs["aria-hidden"], "true");
});

test("strip: integer ticks only, dense above 25, k and n rows, unknown-origin changes sit on the line", () => {
  const days = Array.from({ length: 7 }, (_, i) => `2026-09-0${i + 1}`);
  const rows = days.map((d, i) => ({ d, k: i * 6, n: 300 }));
  const ev = [{ id: "u1", t: "", day: "2026-09-03", kind: "model", side: "unknown", strength: "weak", provenance: null, label: "Model changed", from: "", to: "", isNew: false, marker: "?" }];
  const [svg, desc] = strip({ days, rows, events: ev, hits: new Set(), recentStart: 0, baseDays: null, recentDays: 7, brackets: false, agentName: "Claude Code", kLabel: "errors", nLabel: "tool calls", uid: "t" });
  const ticks = find(svg, (n) => n.attrs.class === "c-tick");
  assert.equal(ticks.length, rows.reduce((s, r) => s + r.k, 0));
  assert.ok(ticks.every((t) => t.attrs.height === "1"), "dense ticks above 25 events a day");
  // a change of unknown origin is a faint tick crossing the line (UX-V2 §7.3), no "?" circle; the description names it
  assert.equal(find(svg, (n) => n.attrs.class === "c-unknown").length, 0);
  const unk = find(svg, (n) => n.attrs.class === "c-unknown-tick");
  const axis = find(svg, (n) => n.attrs.class === "c-axis")[0];
  assert.equal(unk.length, 1);
  assert.ok(Number(unk[0].attrs.y1) < Number(axis.attrs.y1) && Number(unk[0].attrs.y2) > Number(axis.attrs.y1), "the tick crosses the line");
  assert.ok(textOf(desc).includes("change of unknown origin ? on Sep 3"));
  assert.equal(xs(2), "×2"); assert.equal(xs(2.5), "×2.5"); assert.equal(xs(1.15), "×1.15"); assert.equal(fdate("2026-10-03"), "Oct 3");
});

// ---------------------------------------------------------------------------------------------------------------
test("sanitize: escape sequences whole, bidi/invisible/control dropped, marks capped, bounded", () => {
  assert.equal(clean("\u001b[31mred\u001b[0m text", 50), "red text");
  assert.equal(clean("a\u001b]8;;https://x.invalid/\u0007link\u001b]8;;\u0007b", 50), "alinkb");
  assert.equal(clean("evil‮txt.exe​", 50), "eviltxt.exe");
  assert.equal(clean("line1\nline2\t\ttab", 50), "line1 line2 tab");
  assert.equal(clean("Ẓ̵̡̢̤a", 50), "Z̵̡̢a");
  assert.equal(clean("private", 50), "private");
  assert.equal(clean(42, 10), "");
  assert.equal(bound("abcdefghij", 5), "abcd…");
  assert.equal(bound("\u{1F469}\u200d\u{1F4BB}\u{1F469}\u200d\u{1F4BB}\u{1F469}\u200d\u{1F4BB}", 2), "\u{1F469}\u200d\u{1F4BB}…", "bounded by user-perceived characters");
  assert.ok(isBridgeId("claude-code") && !isBridgeId("claude-code\u001b[2J") && !isBridgeId("a b"));
});

test("dom: materialize refuses style, handlers, URLs and dangerous elements", () => {
  const fake = { createTextNode: (t) => ({ t }), createElement: (tag) => fakeEl(tag), createElementNS: (_ns, tag) => fakeEl(tag) };
  function fakeEl(tag) { return { tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); }, addEventListener() {} }; }
  const ok = materialize({ tag: "p", attrs: { class: "x" }, kids: ["hi"] }, fake, () => {});
  assert.equal(ok.attrs.class, "x");
  for (const bad of [{ style: "color:red" }, { onclick: "x()" }, { href: "https://x.invalid" }, { src: "x.png" }, { "xlink:href": "#a" }]) {
    assert.throws(() => materialize({ tag: "p", attrs: bad, kids: [] }, fake, () => {}), /refused attribute/);
  }
  for (const tag of ["script", "style", "iframe", "a", "img", "foreignObject"]) assert.throws(() => materialize({ tag, attrs: {}, kids: [] }, fake, () => {}), /refused element/);
});

test("accessibility: the wordmark is one named image (an aria-label on a role-less span is ignored by assistive tech)", () => {
  const c = byName.get("snapshot-you-and-codex");
  const marks = find(renderApp(decode(c), ui(c, "verdict")), (n) => cls(n).includes("wordmark"));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].attrs.role, "img");
  assert.equal(marks[0].attrs["aria-label"], "wasitme");
});

// The canvas's own colour pairs (ui/static/canvas.css), computed from the design tokens in both themes. The design
// system's contrast report (design/system/generated/contrast-report.md) covers its own pairs; these are the ones the
// canvas makes by remapping tokens: the dimmed last-known state and the focus ring on the selected switcher segment.
test("contrast: the canvas's own token pairs pass in light and dark (dimmed markers, the inset focus rings)", () => {
  const tokensCss = readFileSync(join(ROOT, "design/system/generated/tokens.css"), "utf8");
  const block = (sel) => { const i = tokensCss.indexOf(sel); assert.ok(i >= 0, sel); return tokensCss.slice(i, tokensCss.indexOf("}", i)); };
  const themes = { light: block(':root, :root[data-theme="light"] {'), dark: block(':root[data-theme="dark"] {') };
  const val = (t, name) => { const m = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(themes[t]); assert.ok(m, `${t} --${name}`); return m[1]; };
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const canvas = readFileSync(join(UI, "static/canvas.css"), "utf8");
  const lastknown = /\.lastknown \{([^}]*)\}/.exec(canvas)[1];
  // what the dimmed state maps each token to (canvas.css .lastknown), so the pairs below follow the stylesheet
  const remap = (name) => { const m = new RegExp(`--${name}:\\s*var\\(--([a-z-]+)\\)`).exec(lastknown); return m ? m[1] : name; };
  assert.equal(remap("you-ink"), "ink-muted", "a dimmed marker's letter is muted ink, not the near-black party ink");
  assert.equal(remap("agent-ink"), "ink-muted");
  assert.match(canvas, /\.switcher \.seg\.on:focus-visible \{ outline-color: var\(--accent-action-text\); \}/);
  for (const t of ["light", "dark"]) {
    const pairs = [
      // text 4.5:1: a marker's letter on its dimmed sticker / tag (the strip's c-mk-text uses --you-ink on both)
      [remap("you-ink"), remap("you-fill"), 4.5], [remap("agent-ink"), remap("agent-fill"), 4.5], [remap("you-ink"), remap("agent-fill"), 4.5],
      // non-text 3:1: the inset ring on the selected (ink) segment, and the ring on the sidebar and the selected row
      ["accent-action-text", "accent-action", 3], ["accent-focus", "surface-sidebar", 3], ["accent-focus", "surface-sheet", 3],
    ];
    for (const [fg, bg, need] of pairs) {
      const r = ratio(val(t, fg), val(t, bg));
      assert.ok(r >= need, `${t}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs ${need}:1`);
    }
  }
});

test("motion: the shipped stylesheet has no transition or animation (D48: no animation; reduced motion is the only motion)", () => {
  const css = readFileSync(join(UI, "dist/app.css"), "utf8");
  assert.doesNotMatch(css, /\btransition\s*:|\banimation(-name)?\s*:|@keyframes|scroll-behavior\s*:\s*smooth/);
});

test("the shipped bundle: no innerHTML, eval, string timers, rAF, network APIs or inline script/style", () => {
  const js = readFileSync(join(UI, "dist/app.js"), "utf8"), html = readFileSync(join(UI, "dist/app.html"), "utf8"), css = readFileSync(join(UI, "dist/app.css"), "utf8");
  for (const re of [/\b(inner|outer)HTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /requestAnimationFrame/, /\bfetch\s*\(/, /XMLHttpRequest|WebSocket|EventSource|sendBeacon/, /\.style\s*=|cssText|setAttribute\(\s*["']style/]) assert.doesNotMatch(js, re);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle=|\son[a-z]+=/i);
  assert.match(html, /<script src="app\.js" defer><\/script>/);
  assert.doesNotMatch(css.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ""), /https?:\/\//);
  assert.doesNotMatch(css, /opacity\s*:/, "no opacity dimming (DESIGN.md)");
  for (const f of ["WasitmeSerif-Regular", "WasitmeSerif-Italic", "WasitmeSerif-Bold", "WasitmeSerif-BoldItalic", "WasitmeMono-Regular", "WasitmeMono-Bold"]) assert.ok(css.includes(`url("fonts/${f}.woff2")`), f);
});

test("ui/src has no network code (scripts/check-no-network.mjs)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/check-no-network.mjs"), join(UI, "src")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the header the app sends carries every D48 directive (CanvasRouter.swift)", () => {
  const csp = realCsp(ROOT);
  for (const d of ["default-src 'none'", "script-src wasitme-app:", "style-src wasitme-app:", "img-src wasitme-app: data:", "font-src wasitme-app:"]) assert.ok(csp.includes(d), d);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|connect-src|https?:/);
});

// ---------------------------------------------------------------------------------------------------------------
// Findings from the 2026-10-05 release-readiness review (apple area), each held by a test.
const renderDoc = (doc, now, page, more = {}) => { const d = decodeSnapshot(doc, { nowMs: Date.parse(now) }); return { d, tree: renderApp(d, { page, agent: 0, chrome: "full", nowMs: Date.parse(now), timeZone: "UTC", ...more }) }; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const sidebarBlock = (tree) => {
  const nb = find(tree, (n) => cls(n).includes("nblock"))[0];
  return nb ? { title: textOf(find(nb, (n) => cls(n).includes("nblock-title"))[0]), nums: find(nb, (n) => n.tag === "b").map(textOf) } : null;
};

test("sidebar: 'Read in the last N days' shows the recent window's counts, never the both-window totals in n", () => {
  // The engine's n counts BOTH windows (engine/src/words/facts.ts); the goldens happen to have n == recent, so make them differ.
  const c = byName.get("snapshot-you-and-codex");
  const doc = clone(c.doc);
  const a = doc.agents[0], w = a.windows;
  a.n = { exchanges: w.recent.exchanges + w.baseline.exchanges, sessions: w.recent.sessions + 2, sessionDays: w.recent.sessionDays + w.baseline.sessionDays, days: 40 };
  for (const page of PAGE_IDS) {
    const sb = sidebarBlock(renderDoc(doc, c.now, page).tree);
    assert.equal(sb.title, `Read in the last ${w.recent.days} days`, page);
    assert.deepEqual(sb.nums, [num(w.recent.exchanges), num(w.recent.sessionDays), num(w.recent.sessions)], `${page}: the recent window's numbers`);
  }
  // no comparison window (Codex while calibration is pending): everything read so far, under a title that says so
  const sb = sidebarBlock(renderDoc(doc, c.now, "verdict", { agent: 1 }).tree);
  const n = doc.agents[1].n;
  assert.equal(sb.title, "Read so far");
  assert.deepEqual(sb.nums, [num(n.exchanges), num(n.sessionDays), num(n.sessions)]);
});

test("Settings → Privacy lists exactly the mod's enforced call allow-list (plugin/tests/check-calls.mjs)", () => {
  const src = readFileSync(join(ROOT, "plugin/tests/check-calls.mjs"), "utf8");
  const block = /const ALLOWED_CALLS = \[([\s\S]*?)\]/.exec(src);
  assert.ok(block, "ALLOWED_CALLS not found in plugin/tests/check-calls.mjs");
  const allowed = [...block[1].matchAll(/'([a-z]+\.[A-Za-z]+)'/g)].map((m) => `$.${m[1]}`).sort();
  assert.ok(allowed.length >= 8, `parsed ${allowed.length} calls`);
  assert.deepEqual(MOD_CALLS.split(", ").sort(), allowed);
  const c = byName.get("snapshot-you-and-codex");
  const d = decode(c);
  assert.ok(!allText(renderApp(d, ui(c, "settings"))).includes(MOD_CALLS), "behind its disclosure by default");
  const open = allText(openAll(d, ui(c, "settings")));
  assert.ok(open.includes(MOD_CALLS), "the page shows the frozen list (D50) once opened");
  assert.ok(open.includes("It runs inside Claude Code with your permissions, and can only:"), "with D50's disclosure");
  // in words: each line names the calls or hooks it covers, together exactly the allow-list and the plugin's hooks
  assert.deepEqual(PLUGIN_CAN.flatMap((x) => x.calls).sort(), allowed, "the lines in words cover exactly the enforced calls");
  const hooks = Object.keys(JSON.parse(readFileSync(join(ROOT, "plugin/hooks/hooks.json"), "utf8")).hooks).sort();
  assert.deepEqual([...new Set(PLUGIN_CAN.flatMap((x) => x.hooks))].sort(), hooks, "and exactly the hooks in plugin/hooks/hooks.json");
  for (const x of PLUGIN_CAN) assert.ok(open.includes(x.words), x.words);
  // the six project files the session-start hook notes (engine/src/store/projsnap.ts PROJECT_FILES), all named
  const proj = readFileSync(join(ROOT, "engine/src/store/projsnap.ts"), "utf8");
  const files = [...proj.matchAll(/rel: \[([^\]]+)\]/g)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).join("/"));
  assert.equal(files.length, 6);
  for (const f of files) assert.ok(tokens.copy.canvas.settings.pluginCan.projectFiles.includes(f), `names ${f}`);
});

/** The disabled control's reason: its title (the sidebar switcher) or the row text it is described by. */
function reasonOf(tree, n) {
  if (n.attrs.title) return n.attrs.title;
  const id = n.attrs["aria-describedby"];
  const el = id ? find(tree, (x) => x.attrs.id === id)[0] : null;
  return el ? textOf(el).trim() : "";
}

test("no control without something behind it (UX-V2 §2.5, §9.4): unbacked controls are disabled with their reason, never a Terminal how-to", () => {
  for (const r of RENDERS) {
    const all = nodes(r.tree).map(({ n }) => n);
    for (const n of all.filter((x) => x.tag === "button" && x.attrs.disabled !== undefined)) {
      assert.ok(reasonOf(r.tree, n), `${r.c.name}/${r.page}: a disabled control without its reason`);
    }
    if (r.page === "compare") assert.doesNotMatch(allText(r.tree).join(" "), /recomputes|pick two windows|Custom…|Around |later version/, `${r.c.name}: compare promises`);
    if (r.page === "settings" && find(r.tree, (n) => cls(n).includes("sgroup")).length) {
      const text = allText(r.tree).join(" ");
      assert.doesNotMatch(text, /Terminal|uninstall\.sh|--purge|asks you to confirm/, `${r.c.name}: Settings is never a Terminal how-to`);
      // without view.settings (a plain browser, or an app that doesn't back the actions yet) every Settings control is
      // drawn disabled with that reason: the page never offers what nothing behind it can do
      if (!r.open || r.chrome === "full") {
        const controls = nodes(r.tree).filter(({ n, parents }) => n.tag === "button" && n.act?.action !== "toggleSection" && parents.some((p) => cls(p).includes("sgroup")));
        // two switches (desktop panel, launch at login) and four buttons (update, show in Finder, clear, uninstall); the
        // integrations show no control while their state is unknown
        assert.equal(controls.length, 6, `${r.c.name}: the Settings controls`);
        for (const { n } of controls) {
          assert.ok(n.attrs.disabled !== undefined && !n.act, `${r.c.name}: "${textOf(n) || n.attrs["aria-label"]}" offered before native backs it`);
          assert.equal(reasonOf(r.tree, n), "Not available in this version.");
        }
      }
      for (const n of all.filter((x) => x.act && SETUP_ACTIONS.has(x.act.action))) assert.equal(n.attrs.disabled, undefined, "a control that posts is enabled");
    }
  }
  const c = byName.get("snapshot-you-and-codex");
  const compare = renderDoc(c.doc, c.now, "compare").tree;
  assert.equal(textOf(find(compare, (n) => cls(n).includes("t-deck"))[0]), "Recent 14 days against the 4 weeks before.");
});

test("Settings (UX-V2 §9): each row's control follows the state native reports; ids and keys are the bridge's", () => {
  const c = byName.get("snapshot-you-and-codex");
  const d = decode(c);
  const page = (view) => renderApp(d, ui(c, "settings", { chrome: "content", settings: decodeSettings(view) }));
  const ctl = (tree, title) => {
    const row = find(tree, (n) => cls(n).includes("srow")).find((n) => textOf(find(n, (x) => cls(x).includes("srow-title"))[0]) === title);
    assert.ok(row, title);
    const b = find(row, (n) => n.tag === "button")[0] ?? null;
    return { row, b, state: textOf(find(row, (x) => cls(x).includes("srow-state"))[0]), desc: textOf(find(row, (x) => cls(x).includes("srow-desc"))[0]) };
  };
  const t = page(WIRED);
  assert.deepEqual(ctl(t, "Menu bar app").b.act, { action: "removeIntegration", integration: "app" });
  assert.equal(textOf(ctl(t, "Menu bar app").b), "Remove…");
  assert.deepEqual(ctl(t, "Claude Code plugin").b.act, { action: "addIntegration", integration: "claude-plugin" });
  assert.equal(ctl(t, "Status line").b, null, "your own status line: no control");
  assert.equal(ctl(t, "Status line").state, "Yours");
  assert.equal(ctl(t, "Codex skill").b, null);
  assert.equal(ctl(t, "Codex skill").desc, "Codex isn’t installed.");
  assert.deepEqual(ctl(t, "Background scan").b.act, { action: "removeIntegration", integration: "scan" }, "IntegrationID's raw value for the scan");
  assert.equal(textOf(ctl(t, "Background scan").b), "Turn Off…");
  const login = ctl(t, "Launch at login").b;
  assert.equal(login.attrs.role, "switch"); assert.equal(login.attrs["aria-checked"], "false");
  assert.deepEqual(login.act, { action: "setLaunchAtLogin", enabled: true }, "a JavaScript boolean, as BridgePolicy.strictBool wants");
  assert.deepEqual(ctl(t, "Desktop panel").b.act, { action: "setDesktopPanel", enabled: true });
  assert.ok(ctl(t, "Updates").b.attrs.disabled !== undefined, "no release yet");
  assert.equal(ctl(t, "Updates").desc, "Updates arrive with the first public release.");
  for (const [title, action] of [["Saved history", "revealDataFolder"], ["Clear history", "clearHistory"], ["Uninstall wasitme", "uninstallAll"]]) {
    const x = ctl(t, title);
    assert.deepEqual(x.b.act, { action }); assert.equal(x.b.attrs.disabled, undefined, title);
  }
  // the installer starts the app at login: shown on, and left to it
  const via = ctl(page({ ...WIRED, launchAtLogin: "viaInstaller" }), "Launch at login");
  assert.equal(via.b.attrs["aria-checked"], "true"); assert.ok(via.b.attrs.disabled !== undefined); assert.equal(via.desc, "Set by the installer.");
  // while an action runs, its row says so and the group's controls wait
  const busy = page({ ...WIRED, settings: { ...WIRED.settings, busy: "claude-plugin" } });
  assert.equal(ctl(busy, "Claude Code plugin").state, "Working…");
  assert.ok(ctl(busy, "Menu bar app").b.attrs.disabled !== undefined);
  // a run another copy of the app started (native knows only its kind): every change waits, Show in Finder doesn't
  const other = page({ ...WIRED, settings: { ...WIRED.settings, busy: "removeIntegration" } });
  for (const title of ["Menu bar app", "Claude Code plugin", "Background scan", "Clear history", "Uninstall wasitme"]) {
    assert.ok(ctl(other, title).b.attrs.disabled !== undefined && !ctl(other, title).b.act, `${title} waits for the other run`);
  }
  assert.deepEqual(ctl(other, "Saved history").b.act, { action: "revealDataFolder" });
  assert.equal(ctl(other, "Uninstall wasitme").desc, "Removes every part and restores what wasitme changed.", "waiting keeps the row's words");
  // no install record: Unknown, the reason, no control
  const none = ctl(page({ settings: { version: "0.1.0", integrations: [] } }), "Claude Code plugin");
  assert.equal(none.state, "Unknown"); assert.equal(none.b, null); assert.equal(none.desc, "No install record; run the installer once.");
  // the installer hasn't answered (SettingsState.initial, or --status failed): nothing it runs is offered, with that reason
  const unread = page({ ...WIRED, settings: { ...WIRED.settings, answered: false, installed: false, version: null,
    integrations: WIRED.settings.integrations.map(({ id }) => ({ id, state: "unknown" })), update: { available: false } } });
  for (const title of ["Menu bar app", "Claude Code plugin", "Background scan"]) {
    // no control and the state Unknown; the row keeps its own words, so the reason isn't repeated on every row
    assert.equal(ctl(unread, title).b, null); assert.equal(ctl(unread, title).state, "Unknown");
    assert.doesNotMatch(ctl(unread, title).desc, /Not read yet|No install record/);
  }
  for (const title of ["Updates", "Uninstall wasitme"]) {
    const x = ctl(unread, title);
    assert.ok(x.b.attrs.disabled !== undefined && !x.b.act, title); assert.equal(x.desc, "Not read yet; open Settings again to retry.");
  }
  assert.deepEqual(ctl(unread, "Clear history").b.act, { action: "clearHistory" }, "the engine, not the installer, clears the history");
  // answered, but no install record: the installer has nothing to act on, and says so
  const bare = page({ ...WIRED, settings: { ...WIRED.settings, installed: false, update: { available: true } } });
  for (const title of ["Menu bar app", "Updates", "Uninstall wasitme"]) assert.ok(!ctl(bare, title).b.act, `${title}: no install to change`);
  assert.equal(ctl(bare, "Uninstall wasitme").desc, "No install record; run the installer once.");
  // no engine set up: nothing saved to clear
  const noEngine = ctl(page({ ...WIRED, settings: { ...WIRED.settings, canClearHistory: false } }), "Clear history");
  assert.ok(noEngine.b.attrs.disabled !== undefined && !noEngine.b.act); assert.equal(noEngine.desc, "No install record; run the installer once.");
  // the deck: the version, local only
  assert.equal(textOf(find(t, (n) => cls(n).includes("t-deck"))[0]), "wasitme 0.1.0 · local only");
  // every word the Settings rows use fits the row budget (§11.2: a description is at most 12 words)
  const S = tokens.copy.canvas.settings;
  for (const [k, v] of Object.entries(S.row)) assert.ok(v.desc.split(/\s+/).length <= 12, `settings.row.${k}.desc`);
  for (const [k, v] of Object.entries(S.why)) assert.ok(v.split(/\s+/).length <= 12, `settings.why.${k}`);
});

test("the canvas posts only what the Mac app's bridge accepts, with its exact keys (CanvasBridge.swift)", () => {
  const swift = readFileSync(join(ROOT, "macos/Sources/WasitmeUI/Canvas/CanvasBridge.swift"), "utf8");
  // actionKeys maps each action to the key sets it accepts besides `action`, one of them per message:
  //   "setLaunchAtLogin": [["enabled"], ["value"]], "clearHistory": [[]], ...
  const block = /static let actionKeys: \[String: \[Set<String>\]\] = \[([\s\S]*?)\n    \]/.exec(swift);
  assert.ok(block, "BridgePolicy.actionKeys");
  const accepted = new Map([...block[1].matchAll(/"([A-Za-z]+)": \[((?:\[[^\]]*\](?:, )?)+)\]/g)].map((m) =>
    [m[1], [...m[2].matchAll(/\[([^\]]*)\]/g)].map((set) => [...set[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]).sort().join(","))]));
  assert.ok(accepted.size >= 14, `actionKeys parsed (${[...accepted.keys()].join(" ")})`);
  // IntegrationID lives with the setup commands that use it (WasitmeCore); its raw values are what the page sends
  const core = readFileSync(join(ROOT, "macos/Sources/WasitmeCore/Setup/SetupCommand.swift"), "utf8");
  const ids = /enum IntegrationID: String[\s\S]*?\n}/.exec(core);
  assert.ok(ids, "IntegrationID in SetupCommand.swift");
  const swiftIds = [...ids[0].matchAll(/^    case (\w+)(?: = "([a-z-]+)")?$/gm)].map((m) => m[2] ?? m[1]);
  assert.deepEqual(swiftIds.sort(), [...INTEGRATION_IDS].sort(), "the integration ids are IntegrationID's raw values");
  const keysOf = (act) => Object.keys(act).filter((k) => k !== "action" && k !== "index" && act[k] !== undefined).sort().join(",");
  const posted = new Set();
  // plus Settings with an update on offer (WIRED has none before the first release)
  const c = byName.get("snapshot-you-and-codex");
  const withUpdate = { ...WIRED, settings: { ...WIRED.settings, update: { available: true } } };
  const extra = { tree: renderApp(decode(c), ui(c, "settings", { chrome: "content", settings: decodeSettings(withUpdate) })) };
  for (const r of [...RENDERS, extra]) for (const { n } of nodes(r.tree)) {
    if (!n.act || n.act.action === "toggleSection") continue;
    if (n.act.action === "selectAgent" && n.act.agent === undefined) continue;   // main.ts posts nothing without a bridge id
    assert.ok(accepted.has(n.act.action), `${n.act.action} is a bridge action`);
    assert.ok(accepted.get(n.act.action).includes(keysOf(n.act)), `${n.act.action}: exactly one key set BridgePolicy accepts (got "${keysOf(n.act)}")`);
    posted.add(n.act.action);
  }
  // every Settings action the page can post was checked above on a wired render, not skipped
  for (const a of SETUP_ACTIONS) assert.ok(posted.has(a), `${a} is posted by some render and checked`);
});

test("the canvas reads every field the Mac app sends in view.settings (SettingsState.viewObject)", () => {
  const swift = readFileSync(join(ROOT, "macos/Sources/WasitmeCore/Setup/SettingsState.swift"), "utf8");
  const body = /public var viewObject: \[String: Any\] \{([\s\S]*?)\n    \}/.exec(swift);
  assert.ok(body, "SettingsState.viewObject");
  const sent = [...body[1].matchAll(/^            "([A-Za-z]+)": /gm)].map((m) => m[1]);
  assert.ok(sent.length >= 9, `viewObject keys parsed (${sent.join(" ")})`);
  const view = readFileSync(join(ROOT, "ui/src/view.ts"), "utf8");
  for (const k of sent) assert.ok(view.includes(`own(s, "${k}")`), `view.ts reads settings.${k}`);
});

test("view.settings is read like the snapshot: own keys, closed vocabularies, the scan's two names", () => {
  const s = decodeSettings({ launchAtLogin: "viaInstaller", settings: { version: "0.1.0", integrations: [{ id: "scan-agent", state: "on" }, { id: "bogus", state: "on" },
    { id: "statusline", state: "weird" }, { id: "codex-plugin", state: "unavailable", why: "agent_missing" }], desktopPanel: "yes", update: { available: true }, busy: "rm -rf" } });
  assert.equal(s.wired, true);
  assert.deepEqual(s.parts.scan, { state: "on", why: null });
  assert.equal(s.parts.bogus, undefined);
  assert.deepEqual(s.parts.statusline, { state: "unknown", why: null });
  assert.equal(s.parts["codex-plugin"].why, "agent_missing");
  assert.equal(s.desktopPanel, null, "a string is not a boolean");
  assert.deepEqual(s.update, { available: true, why: null });
  assert.equal(s.busy, null, "not an id or an action name");
  assert.equal(s.launchAtLogin, "viaInstaller");
  assert.equal(decodeSettings({ launchAtLogin: "unavailable", settings: { launchAtLogin: false } }).launchAtLogin, "off", "the install record answers when the app can't");
  assert.equal(decodeSettings(null).wired, false);
  const proto = JSON.parse('{"settings":{"__proto__":{"version":"9"}}}');
  assert.equal(decodeSettings(proto).version, null);
});

test("Report page: an honest summary in the engine report's order (finding first, whatever the lead), no row numbers", () => {
  for (const name of ["snapshot-agent-by_elimination", "snapshot-you-and-codex", "snapshot-insufficient-timeline"]) {
    const c = byName.get(name);
    for (const lead of ["timeline", "verdict"]) {
      const { d, tree } = renderDoc({ ...clone(c.doc), lead }, c.now, "report");
      const a = d.agents[0];
      const sheet = find(tree, (n) => cls(n).includes("report-sheet"))[0];
      const blocks = sheet.kids.flat(Infinity).filter((k) => k && typeof k === "object");
      assert.ok(cls(blocks[1]).includes("r-finding"), `${name}/${lead}: the finding comes right after the title`);
      const heads = find(sheet, (n) => n.tag === "h3").map(textOf);
      const order = ["What was checked", "What moved", " per day", "Timeline", "How wasitme decided"].map((h) => heads.findIndex((x) => x === h || x.includes(h))).filter((i) => i >= 0);
      assert.deepEqual(order, [...order].sort((x, y) => x - y), `${name}/${lead}: engine order, got ${heads.join(" | ")}`);
      assert.ok(heads.includes("Timeline"), "the timeline heading carries no text legend (the badges are drawn)");
      const text = allText(sheet).join(" ");
      assert.doesNotMatch(text, /\brow \d|this row decided|Why this finding/, `${name}/${lead}: decision-table jargon`);
      assert.doesNotMatch(text, /\(update\)|[■▲]/, `${name}/${lead}: no text glyphs and no “(update)” (report item 4)`);
      if (a.trace.length) assert.ok(heads.includes("How wasitme decided") && text.includes("(this decided it)"));
      if (a.tryThis) assert.ok(text.includes("Next:") && text.includes(a.tryThis), `${name}: Next`);
      if (a.because) assert.ok(text.includes(a.because));
      // the timeline list: one row per change (wasitme's own excluded), each with its drawn badge
      const rows = find(sheet, (n) => cls(n).includes("chg"));
      assert.equal(rows.length, a.timeline.filter((e) => e.side !== "meta").length);
      assert.ok(rows.every((r) => find(r, (n) => cls(n).includes("bdg")).length === 1));
    }
  }
  const c = byName.get("snapshot-agent-by_elimination");
  const sub = textOf(find(renderDoc(c.doc, c.now, "report").tree, (n) => n.tag === "p" && cls(n).includes("t-deck"))[0]);
  assert.equal(sub, "What Copy Report puts on your clipboard: numbers only, no prompts, code or paths.");
});

test("screen-reader text: the chart says its metric, counts are pluralized, a marker says when and what", () => {
  assert.deepEqual(knWords("toolErrorsNonCmd", "per 100 tool calls"), ["errors", "tool calls"], "D61's voting construct has its words");
  assert.equal(countWords(1, "errors"), "1 error"); assert.equal(countWords(47, "tool calls"), "47 tool calls");
  assert.equal(countWords(1, "tool calls"), "1 tool call"); assert.equal(countWords(1, "opportunities"), "1 opportunity");
  assert.equal(countWords(1, "changes"), "1 change"); assert.equal(countWords(1234, "errors"), "1,234 errors");
  const days = ["2026-07-22", "2026-07-23"];
  const [svg, desc] = strip({ days, rows: [{ d: days[0], k: 3, n: 120 }, { d: days[1], k: 1, n: 47 }], events: [], hits: new Set(), recentStart: 0, baseDays: null,
    recentDays: 2, brackets: false, agentName: "Claude Code", title: "Tool errors (excl. commands)", kLabel: "errors", nLabel: "tool calls", uid: "sr" });
  assert.equal(svg.attrs["aria-label"], "Tool errors (excl. commands) per day, Jul 22 to Jul 23: 4 errors in 167 tool calls");
  assert.ok(textOf(desc).includes("Jul 23: 1 error in 47 tool calls"), textOf(desc));
  assert.doesNotMatch(textOf(desc), /\b1 errors\b|\b1 events\b/);
  let markers = 0;
  for (const r of RENDERS.filter((x) => !x.c.name.includes("hostile") && x.d.agents.length)) {
    const names = r.d.agents.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`^(your change \\w+|(${names}) change \\w+|change of unknown origin), [A-Z][a-z]{2} \\d{1,2}: \\S`);
    for (const n of find(r.tree, (x) => cls(x).includes("bdg") && x.attrs["aria-label"])) {
      markers++;
      assert.equal(n.attrs.role, "img", "one named image");
      assert.match(n.attrs["aria-label"], re, `${r.c.name}/${r.page}`);
      assert.ok(find(n, (x) => x.tag === "svg").every((x) => x.attrs["aria-hidden"] === "true"), "the drawing itself is hidden");
    }
  }
  assert.ok(markers > 100, `${markers} markers checked`);
});

test("copy: the routine-update note is said once per list, never per row; Sources names no internal reader ids or 'null runs'", () => {
  for (const r of RENDERS.filter((x) => x.page === "timeline" && x.d.display === "ok" && x.open)) {
    const text = allText(r.tree);
    const notes = text.filter((t) => t.includes("updates alone aren’t evidence"));
    const routine = r.d.agents[r.agent].timeline.some((e) => e.side === "agent" && e.strength === "routine");
    assert.ok(notes.length <= 1, `${r.c.name}: the note repeats ${notes.length} times`);
    for (const row of find(r.tree, (n) => cls(n).includes("chg"))) assert.doesNotMatch(textOf(row), /updates alone|\(update\)/, `${r.c.name}: per-row note`);
    assert.equal(find(r.tree, (n) => cls(n).includes("foot")).some((f) => textOf(f).includes("updates alone aren’t evidence")), routine, `${r.c.name}/${r.agent}: footnote iff routine updates`);
  }
  const c = byName.get("snapshot-you-and-codex");
  const doc = clone(c.doc);
  doc.health.parserVersions = { claudeCodeContext: 2, codexContext: 1, claudeCodeEvents: 3, toolErrors: 1 };
  doc.calibration = { artifactDate: "2026-10-05", methodId: "m", agents: [{ agent: "claude-code", calibrated: true, sequences: 6000 }, { agent: "codex", calibrated: false, sequences: 300 }] };
  const sd = decodeSnapshot(doc, { nowMs: Date.parse(c.now) });
  const text = allText(openAll(sd, ui(c, "sources"))).join(" ");
  assert.doesNotMatch(text, /claudeCodeContext|codexContext|claudeCodeEvents|toolErrors v1|null runs/);
  assert.ok(text.includes("4 readers recorded") && text.includes("wasitme doctor"));
  assert.ok(text.includes("findings on: tested on 6,000 synthetic no-change runs (Oct 5)"), text);
  assert.ok(text.includes("findings off; the tests haven’t passed yet (300 synthetic no-change runs)"));
});

/** Every label and marker on a strip's two marker rows, as [left, right] boxes keyed by row (the label baseline). */
function rowBoxes(svg) {
  const rows = new Map();
  const add = (y, box) => { const k = Math.round(Number(y)); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(box); };
  for (const n of find(svg, (x) => x.tag === "text" && (x.attrs.class === "c-label-2" || x.attrs.class === "c-side"))) {
    const x = Number(n.attrs.x), w = Array.from(textOf(n)).length * 7.3;
    const end = n.attrs["text-anchor"] === "end";
    // only the marker rows: the bracket captions (c-side, middle-anchored) sit lower and are not in a lane
    if (n.attrs["text-anchor"] === "middle") continue;
    add(n.attrs.y, { kind: n.attrs.class === "c-side" ? "lane" : "label", text: textOf(n), l: end ? x - w : x, r: end ? x : x + w });
  }
  // the badges (UX-V2 §7.1): yours an 18 px square (wider for a range) drawn 0.5 px inside its box (box 6..24, label
  // baseline 19); the agent's an 18 × 20 tag (wider for a range) whose path starts at its point, (box centre, box y +
  // 0.5), with its label baseline at box y + 16; its box is the path's own extent
  for (const n of find(svg, (x) => x.tag === "rect" && x.attrs.class === "c-you")) {
    const x = Number(n.attrs.x) - 0.5;
    add(Number(n.attrs.y) - 0.5 + 13, { kind: "marker", text: "■", l: x, r: x + Number(n.attrs.width) + 1 });
  }
  for (const n of find(svg, (x) => x.tag === "path" && /^c-agent/.test(x.attrs.class ?? ""))) {
    const b = pathBox(n.attrs.d);
    add(b.top - 0.5 + 16, { kind: "marker", text: "▲", l: b.left - 0.5, r: b.right + 0.5 });
  }
  return rows;
}

/** The extent of a path drawn with M, L, Q, H and V (absolute coordinates only, as agentPath writes them). */
function pathBox(d) {
  const xs = [], ys = [];
  for (const [, cmd, args] of d.matchAll(/([MLQHVZ])([^MLQHVZ]*)/g)) {
    const v = args.trim() ? args.trim().split(/[ ,]+/).map(Number) : [];
    if (cmd === "H") xs.push(...v);
    else if (cmd === "V") ys.push(...v);
    else for (let i = 0; i + 1 < v.length; i += 2) { xs.push(v[i]); ys.push(v[i + 1]); }
  }
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** No label or marker on a strip's marker rows overlaps another, the lane label, or runs off the chart. Returns how many
 *  labels and markers it checked. */
function assertRowsClear(svg, where) {
  const width = Number(svg.attrs.width);
  let labels = 0, markers = 0;
  for (const [y, boxes] of rowBoxes(svg)) {
    const lane = boxes.find((b) => b.kind === "lane");
    for (const b of boxes.filter((x) => x.kind !== "lane")) {
      if (b.kind === "label") labels++; else markers++;
      assert.ok(b.r <= width, `${where}: ${b.kind} "${b.text}" runs off the chart (${b.r.toFixed(0)} > ${width})`);
      if (lane) assert.ok(b.l >= lane.r + 2, `${where}: ${b.kind} "${b.text}" overlaps the lane label "${lane.text}"`);
      for (const o of boxes) {
        if (o === b || o.kind === "lane") continue;
        assert.ok(b.r <= o.l + 0.5 || b.l >= o.r - 0.5, `${where} row ${y}: ${b.kind} "${b.text}" [${b.l.toFixed(0)}, ${b.r.toFixed(0)}] overlaps ${o.kind} "${o.text}" [${o.l.toFixed(0)}, ${o.r.toFixed(0)}]`);
      }
    }
  }
  return { labels, markers };
}

test("chart labels never overlap a marker, another label or the lane label, at a real update cadence", () => {
  const c = denseUpdates();
  const d = decodeSnapshot(c.doc, { nowMs: Date.parse(c.now) });
  assert.ok(d.agents[0].timeline.filter((e) => e.side === "agent").length >= 25, "the dense fixture has its updates");
  let labels = 0, dropped = 0;
  for (const page of ["timeline", "verdict", "setup", "compare"]) for (const chrome of ["full", "content"]) {
    const tree = renderApp(d, ui(c, page, { chrome }));
    for (const svg of find(tree, (n) => n.tag === "svg" && n.attrs.role === "img")) {
      labels += assertRowsClear(svg, page).labels;
      dropped += find(svg, (n) => n.attrs.class === "c-agent-routine" || n.attrs.class === "c-agent").length;
    }
  }
  assert.ok(labels > 4 && dropped > labels, `${labels} labels kept for ${dropped} agent markers: some had to give way`);
});

/** The marks a strip draws, left to right per lane: each `g.c-mark` with its box, its text and its hover tip. */
function stripMarks(svg) {
  return find(svg, (n) => n.tag === "g" && n.attrs.class === "c-mark").map((g) => {
    const rect = find(g, (x) => x.tag === "rect" && x.attrs.class === "c-you")[0];
    const path = find(g, (x) => x.tag === "path" && /^c-agent/.test(x.attrs.class ?? ""))[0];
    const b = rect ? { left: Number(rect.attrs.x) - 0.5, right: Number(rect.attrs.x) + Number(rect.attrs.width) + 0.5 } : pathBox(path.attrs.d);
    return { side: rect ? "you" : "agent", l: rect ? b.left : b.left - 0.5, r: rect ? b.right : b.right + 0.5, text: textOf(find(g, (x) => x.tag === "text")[0]),
      title: textOf(find(g, (x) => x.tag === "title")[0]) };
  }).sort((p, q) => p.l - q.l);
}

test("crowded lanes (UX-V2 §7.3): one mark a day per lane, ranges of consecutive markers, a lined-up change keeps its number", () => {
  for (const base of ["insufficient", "you"]) {
    const c = crowdedChanges(base);
    const d = decodeSnapshot(c.doc, { nowMs: Date.parse(c.now) });
    const a = d.agents[0];
    const hits = new Set(a.candidates.filter((x) => x.status === "open").map((x) => x.event));
    assert.equal(hits.size, base === "you" ? 1 : 0);
    for (const show of [28, 42]) {
      const end = a.windows.recent.to;
      const days = Array.from({ length: show }, (_, i) => new Date(Date.parse(`${end}T00:00:00Z`) - (show - 1 - i) * 86400000).toISOString().slice(0, 10));
      const rows = days.map((dd) => ({ d: dd, k: 3, n: 200 }));
      const [svg, desc] = strip({ days, rows, events: a.timeline, hits, recentStart: show - 14, baseDays: 28, recentDays: 14, brackets: true, agentName: a.name,
        kLabel: "errors", nLabel: "tool calls", width: 960, uid: `crowd${show}`, markLabels: show === 28 ? "key" : "all" });
      const where = `${base}, ${show} days`;
      const inView = a.timeline.filter((e) => e.marker && e.day >= days[0] && e.day <= days[days.length - 1]);
      assert.ok(inView.filter((e) => e.side === "you").length >= 44, `${where}: the fixture is crowded`);
      const ms = stripMarks(svg);
      for (const side of ["you", "agent"]) {
        const lane = inView.filter((e) => e.side === side), ids = lane.map((e) => e.marker);
        const L = ms.filter((m) => m.side === side);
        // every change on the lane is in exactly one mark, in marker order: a range "a–b" stands for a..b, all of them
        const expand = (m) => {
          const [x, y] = m.text.split("–");
          if (y === undefined) return [x];
          const i = ids.indexOf(x), j = ids.indexOf(y);
          assert.ok(i >= 0 && j > i, `${where}: range "${m.text}" names markers of its lane in order`);
          return ids.slice(i, j + 1);
        };
        assert.deepEqual(L.flatMap(expand), ids, `${where}: ${side}'s marks cover its changes once, in order`);
        // a range's hover tip names every change in it with its own marker and full label
        for (const m of L) for (const id of expand(m)) {
          const e = lane.find((x) => x.marker === id);
          assert.ok(m.title.includes(m.text.includes("–") ? `${id} ${e.label}` : e.label), `${where}: "${m.title.slice(0, 60)}" names ${id}`);
        }
        // a lined-up change is never in a range: its own badge, its own number
        for (const e of lane.filter((x) => hits.has(x.id))) assert.ok(L.some((m) => m.text === e.marker), `${where}: ${e.marker} keeps its badge`);
        // one mark a day: a lined-up change has its own; two others share a day only with one between them (a range
        // never skips a marker)
        const dayOf = new Map(lane.map((e) => [e.marker, e.day]));
        const isHit = (q) => !q.text.includes("–") && hits.has(lane.find((e) => e.marker === q.text)?.id);
        L.forEach((m, i) => L.slice(i + 1).forEach((o, k) => {
          if (isHit(m) || isHit(o)) return;
          const shared = expand(m).some((x) => expand(o).some((z) => dayOf.get(x) === dayOf.get(z)));
          assert.ok(!shared || L.slice(i + 1, i + 1 + k).some(isHit), `${where}: "${m.text}" and "${o.text}" share a day`);
        }));
        // each mark sits over its days: a lined-up change exactly on its day, any other at most one badge aside
        const pitch = (960 - 64 - 104) / show, edgeOf = (dd) => 104 + days.indexOf(dd) * pitch - 0.5;
        for (const m of L) {
          const xs = expand(m).map((id) => edgeOf(dayOf.get(id))), lo = Math.min(...xs), hi = Math.max(...xs), mid = (m.l + m.r) / 2;
          const off = mid < lo ? lo - mid : mid > hi ? mid - hi : 0;
          assert.ok(off <= (isHit(m) ? 0.5 : (m.r - m.l) / 2 + 20), `${where}: "${m.text}" sits ${off.toFixed(1)} from its days`);
        }
        // nothing overlaps, nothing runs off: 2 px between marks, clear of the lane label (x0 − 12) and the chart's end
        L.forEach((m, i) => { if (i) assert.ok(m.l - L[i - 1].r >= 2 - 0.01, `${where}: "${L[i - 1].text}" and "${m.text}" are ${(m.l - L[i - 1].r).toFixed(1)} apart`); });
        if (L.length) assert.ok(L[0].l >= 104 - 10 - 0.01 && L[L.length - 1].r <= 960 - 2 + 0.01, `${where}: ${side}'s marks stay on the chart`);
        assert.ok(L.length < lane.length, `${where}: ${side}'s ${lane.length} changes are grouped (${L.length} marks)`);
      }
      // origin unknown: one tick a day; and the text description still lists every change with its own marker
      assert.equal(find(svg, (n) => n.attrs.class === "c-unknown-tick").length, new Set(inView.filter((e) => e.side === "unknown").map((e) => e.day)).size);
      for (const e of inView) assert.ok(textOf(desc).includes(` ${e.marker} on ${fdate(e.day)}: ${e.label}`), `${where}: the description lists ${e.marker}`);
      assert.match(svg.attrs["aria-label"], new RegExp(`; ${inView.length} changes marked$`));
      assertRowsClear(svg, where);
    }
    // and on every page that draws a strip, in both chromes, with every disclosure open
    for (const page of ["timeline", "verdict", "setup", "compare"]) for (const chrome of ["full", "content"]) {
      for (const svg of find(openAll(d, ui(c, page, { chrome })), (n) => n.tag === "svg" && n.attrs.role === "img")) assertRowsClear(svg, `${base} ${page} ${chrome}`);
    }
  }
});

/** Where a lined-up mark's short label went: "chart" (right beside its badge), "legend" (an item drawing its badge with
 *  its marker, named for assistive tech, then "<word>: lines up with the shift"), or null. Never both. */
function labelOf(svg, lg, marker, word, name) {
  const m = stripMarks(svg).find((x) => x.text === marker);
  assert.ok(m, `the badge ${marker} is drawn on its own`);
  const beside = find(svg, (n) => n.tag === "text" && n.attrs.class === "c-label-2" && textOf(n) === word).some((n) => {
    const x = Number(n.attrs.x);
    return n.attrs["text-anchor"] === "end" ? Math.abs(x - (m.l - 6)) < 1 : Math.abs(x - (m.r + 5)) < 1;
  });
  const items = lg === null ? [] : find(lg, (n) => n.tag === "span" && cls(n).includes("lg"));
  const named = items.filter((it) => find(it, (n) => n.tag === "text" && textOf(n) === marker).length === 1);
  for (const it of named) {
    assert.ok(textOf(it).endsWith(`${word}: lines up with the shift`), `the legend names ${marker}: "${textOf(it)}"`);
    if (name) assert.equal(find(it, (n) => n.attrs.role === "img")[0]?.attrs["aria-label"], name, `${marker}'s legend badge is named`);
  }
  assert.ok(!(beside && named.length), `${marker}: labelled once, not on the chart and in the legend`);
  return beside ? "chart" : named.length === 1 ? "legend" : null;
}

test("crowded lanes: a lined-up change keeps its short label, beside its badge when there is room, else in the legend with its badge", () => {
  const c = crowdedChanges("you");
  const d = decodeSnapshot(c.doc, { nowMs: Date.parse(c.now) });
  const a = d.agents[0];
  const hits = new Set(a.candidates.filter((x) => x.status === "open").map((x) => x.event));
  const hit = a.timeline.find((e) => hits.has(e.id));
  assert.equal(shortLabel(hit), "effort");
  assert.match(a.headline, /your effort change/, "the headline names the change");
  // the strip itself, at the Finding's 28 days ("key" labels) and the Timeline's 42 ("all"): ranges abut the lined-up
  // badge on both sides, so its label has no room on its row and goes to the legend
  for (const show of [28, 42]) {
    const end = a.windows.recent.to;
    const days = Array.from({ length: show }, (_, i) => new Date(Date.parse(`${end}T00:00:00Z`) - (show - 1 - i) * 86400000).toISOString().slice(0, 10));
    const [svg, , lg] = strip({ days, rows: days.map((dd) => ({ d: dd, k: 3, n: 200 })), events: a.timeline, hits, recentStart: show - 14, baseDays: 28,
      recentDays: 14, brackets: true, agentName: a.name, kLabel: "errors", nLabel: "tool calls", width: 960, uid: `kept${show}`,
      markLabels: show === 28 ? "key" : "all", hitWords: "lines up with the shift" });
    assert.equal(labelOf(svg, lg, hit.marker, "effort", `your change ${hit.marker}`), "legend", `${show} days`);
  }
  // and on the pages that draw it, where the headline names the change
  for (const page of ["verdict", "timeline"]) for (const chrome of ["full", "content"]) {
    const tree = renderApp(d, ui(c, page, { chrome }));
    const blocks = find(tree, (n) => n.tag === "section" && cls(n).includes("chart-block"))
      .filter((b) => find(b, (n) => n.tag === "svg" && /\bchart--strip\b/.test(n.attrs.class ?? "")).length === 1);
    const placed = blocks.flatMap((b) => {
      const svg = find(b, (n) => n.tag === "svg" && /\bchart--strip\b/.test(n.attrs.class ?? ""))[0];
      if (!stripMarks(svg).some((x) => x.text === hit.marker)) return [];
      return [labelOf(svg, find(b, (n) => n.tag === "p" && cls(n).includes("legend"))[0] ?? null, hit.marker, "effort")];
    });
    assert.ok(placed.length >= 1 && placed.every((p) => p !== null), `${page} ${chrome}: ${JSON.stringify(placed)}`);
  }
  // with room on its row (the golden, uncrowded), the label sits beside the badge and the legend names no change
  const g = byName.get("snapshot-you-and-codex");
  const gd = decode(g), ga = gd.agents[0];
  const gh = ga.timeline.find((e) => ga.candidates.some((x) => x.status === "open" && x.event === e.id));
  const block = find(renderApp(gd, ui(g, "verdict")), (n) => n.tag === "section" && cls(n).includes("chart-block"))
    .find((b) => find(b, (n) => n.tag === "svg" && /\bchart--strip\b/.test(n.attrs.class ?? "")).length === 1);
  const gsvg = find(block, (n) => n.tag === "svg" && /\bchart--strip\b/.test(n.attrs.class ?? ""))[0];
  const glg = find(block, (n) => n.tag === "p" && cls(n).includes("legend"))[0] ?? null;
  assert.equal(labelOf(gsvg, glg, gh.marker, shortLabel(gh)), "chart");
  assert.ok(!glg || !find(glg, (n) => n.tag === "text").length, "no legend item names a change");
});

test("chart labels: a lined-up change's label is placed first, and a crowded lined-up update of the agent's is named in the legend", () => {
  const days = Array.from({ length: 28 }, (_, i) => new Date(Date.parse("2026-09-01T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
  const ev = (id, i, marker, side, kind, extra = {}) => ({ id, t: `${days[i]}T${10 + Number(id.slice(-1))}:00:00Z`, day: days[i], kind, side,
    strength: side === "agent" ? "routine" : "strong", provenance: null, label: `${kind} change ${marker}`, from: "", to: "", isNew: false, marker, ...extra });
  const draw = (events, hits) => strip({ days, rows: days.map((d) => ({ d, k: 3, n: 200 })), events, hits: new Set(hits), recentStart: 14, baseDays: 14,
    recentDays: 14, brackets: true, agentName: "Claude Code", kLabel: "errors", nLabel: "tool calls", width: 960, uid: "prio", hitWords: "lines up with the shift" });
  // Your side: an MCP change three days before your effort change, which lines up with the shift; a mode change the same
  // day abuts the effort badge on its right. Both labels want the gap between the two badges: the lined-up change's
  // label gets it, and the MCP label moves to its own left.
  const yours = [ev("y1", 5, "1", "you", "mcp"), ev("y2", 8, "2", "you", "effort"), ev("y3", 8, "3", "you", "mode")];
  const [svg, , lg] = draw(yours, ["y2"]);
  assert.equal(labelOf(svg, lg ?? null, "2", "effort", "your change 2"), "chart");
  const mcp = find(svg, (n) => n.tag === "text" && n.attrs.class === "c-label-2" && textOf(n) === "MCP")[0];
  const one = stripMarks(svg).find((m) => m.text === "1");
  assert.ok(mcp && mcp.attrs["text-anchor"] === "end" && Math.abs(Number(mcp.attrs.x) - (one.l - 6)) < 1, "the MCP label moved to its badge's left");
  assertRowsClear(svg, "hit-first labels");
  // The agent's side: routine updates on the lined-up update's own day, before and after it, so ranges abut it on both
  // sides: the legend names it with its own filled tag, and the generic "lines up" tag item is not repeated.
  const v = (id, i, marker, from, to) => ev(id, i, marker, "agent", "version", { label: `Claude Code ${from} → ${to}`, from, to });
  const agent = [v("a1", 10, "A", "2.1.300", "2.1.301"), v("a2", 10, "B", "2.1.301", "2.1.302"), v("a3", 10, "C", "2.1.302", "2.1.303"),
    v("a4", 10, "D", "2.1.303", "2.1.304"), v("a5", 10, "E", "2.1.304", "2.1.305")];
  const [asvg, , alg] = draw(agent, ["a3"]);
  assert.deepEqual(stripMarks(asvg).map((m) => m.text), ["A–B", "C", "D–E"]);
  assert.equal(labelOf(asvg, alg, "C", shortLabel(agent[2]), "Claude Code change C"), "legend");
  const items = find(alg, (n) => n.tag === "span" && cls(n).includes("lg")).map((it) => textOf(it));
  assert.ok(!items.includes("lines up with the shift"), `no unnamed "lines up" item beside the named one: ${items.join(" | ")}`);
  assertRowsClear(asvg, "agent hit in the legend");
});

test("laneMarks: a lined-up change splits its day's range, long markers widen, and the lane stays inside its bounds", () => {
  const ev = (id, day, marker, side = "you", strength = "strong") => ({ id, t: "", day, kind: "mcp", side, strength, provenance: null, label: `change ${marker}`, from: "", to: "", isNew: false, marker });
  const edge = (d) => (Number(d.slice(8)) - 1) * 25;
  // one day: 4, 5 (lined up), 6, 7 → "4", "5", "6–7"; the lined-up change stays at its day, the others move aside
  const day = [ev("a", "2026-09-05", "4"), ev("b", "2026-09-05", "5"), ev("c", "2026-09-05", "6"), ev("d", "2026-09-05", "7")];
  const m = laneMarks(day, "you", new Set(["b"]), edge, 0, 400);
  assert.deepEqual(m.map((x) => x.text), ["4", "5", "6–7"]);
  assert.ok(Math.abs(m[1].x + m[1].w / 2 - 100) < 0.5, "the lined-up change sits on its day");
  assert.ok(m[0].x + m[0].w + 2 <= m[1].x + 0.01 && m[1].x + m[1].w + 2 <= m[2].x + 0.01);
  // badges on neighbouring days that nearly fit (19 apart, as at 42 days) are nudged apart and stay two; ranges that
  // overlap by more than a nudge merge into one over both days
  const near = [ev("a", "2026-09-02", "1"), ev("b", "2026-09-03", "2"), ev("c", "2026-09-04", "3")];
  const nudged = laneMarks(near, "you", new Set(), (d) => (Number(d.slice(8)) - 1) * 19, 0, 400);
  assert.deepEqual(nudged.map((x) => x.text), ["1", "2", "3"]);
  assert.ok(nudged.every((x, i) => !i || x.x - (nudged[i - 1].x + nudged[i - 1].w) >= 2 - 0.01));
  const wide = [ev("a", "2026-09-02", "10"), ev("b", "2026-09-02", "11"), ev("c", "2026-09-03", "12"), ev("d", "2026-09-03", "13")];
  assert.deepEqual(laneMarks(wide, "you", new Set(), edge, 0, 400).map((x) => [x.text, x.days.length]), [["10–13", 2]]);
  // an agent's change that isn't a routine update keeps its own badge, like a lined-up change
  const strong = [ev("a", "2026-09-05", "A", "agent", "routine"), ev("b", "2026-09-05", "B", "agent", "strong"), ev("c", "2026-09-05", "C", "agent", "routine")];
  assert.deepEqual(laneMarks(strong, "agent", new Set(), edge, 0, 400).map((x) => [x.text, x.filled]), [["A", false], ["B", true], ["C", false]]);
  // markers of three characters widen their badge instead of spilling out of it
  assert.equal(markWidth("12"), 18);
  assert.ok(markWidth("104") > 18 && markWidth("AAB") > 18 && markWidth("18–21") >= 5 * 7.2 + 6);
  // at the chart's right end a lane is held inside maxRight
  const end = [ev("a", "2026-09-10", "1"), ev("b", "2026-09-10", "2", "you"), ev("c", "2026-09-10", "3")];
  const e = laneMarks(end, "you", new Set(["b"]), edge, 0, 240);
  assert.ok(e[e.length - 1].x + e[e.length - 1].w <= 240 + 0.01 && e[0].x >= 0, "held inside the chart");
  // days that go backward in marker order (a clock reset): ranges keep consecutive markers and nothing overlaps
  const back = laneMarks([ev("a", "2026-09-05", "1"), ev("b", "2026-09-10", "2"), ev("c", "2026-09-05", "3")], "you", new Set(), edge, 0, 400);
  assert.deepEqual(back.flatMap((x) => x.members.map((e) => e.marker)), ["1", "2", "3"]);
  assert.ok(back.every((x, i) => !i || x.x - (back[i - 1].x + back[i - 1].w) >= 2 - 0.01));
  // an agent's range of routine updates is hollow
  const ag = [ev("a", "2026-09-05", "A", "agent", "routine"), ev("b", "2026-09-05", "B", "agent", "routine")];
  assert.deepEqual(laneMarks(ag, "agent", new Set(), edge, 0, 400).map((x) => [x.text, x.filled]), [["A–B", false]]);
});

test("commands are drawn as code, never with Markdown backticks; a message body never repeats its title", () => {
  for (const r of RENDERS) {
    if (r.c.name.includes("hostile")) continue;
    for (const t of allText(r.tree)) assert.ok(!t.includes("`"), `${r.c.name}/${r.page}: backtick in "${t.slice(0, 60)}"`);
  }
  const late = Date.parse(ALL[0].now);
  for (const v of ["notSetUp", "unreadable", "mismatch", "refused"]) {
    const tree = renderApp(decodeSnapshot(null, { nowMs: late, viewDocument: v }), ui(ALL[0], "verdict"));
    const title = h1(tree).replace(/\.$/, "");
    const deck = find(tree, (n) => cls(n).includes("t-deck"))[0];
    assert.ok(!textOf(deck).includes(title), `${v}: "${textOf(deck)}" repeats "${title}"`);
    assert.ok(find(deck, (n) => n.tag === "code" && /wasitme (doctor|update)$/.test(textOf(n))).length === 1, `${v}: the command as code`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// UX-V2 §11.2 and §14: word budgets, and every number still reachable
const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;

test("word budgets (UX-V2 §11.2): engine strings over every golden and demo case, and every sentence the canvas owns", () => {
  const demo = JSON.parse(readFileSync(join(ROOT, "design/system/demo-data.v3.json"), "utf8"));
  const engine = [
    ...ALL.flatMap((c) => decode(c).agents.map((a) => ({ where: c.name, deck: a.headline, note: a.because, next: a.tryThis, confidence: a.confidence }))),
    ...Object.entries(demo.cases).map(([k, x]) => ({ where: `demo ${k}`, deck: x.headline, note: x.because, next: x.next, confidence: x.confidence })),
  ];
  for (const e of engine) {
    if (e.where.includes("hostile")) continue;
    assert.ok(words(e.deck) <= 14, `${e.where}: deck ${words(e.deck)} words`);
    assert.ok(words(e.note) <= 30, `${e.where}: note ${words(e.note)} words`);
    assert.ok(words(e.next) <= 18, `${e.where}: next step ${words(e.next)} words`);
    assert.ok(words(e.confidence) <= 23, `${e.where}: confidence ${words(e.confidence)} words`);
  }
  for (const s of Object.values(tokens.states)) if (s && s.headline) assert.ok(words(s.headline) <= 4, `title "${s.headline}"`);
  // UI-owned sentences: 14 words; the exceptions define marks, name files or are message pages kept as they were (§11.3)
  const EXCEPT = { "ledger.key": 20, "settings.pluginCan.projectFiles": 40, "report.movedNote": 30, "message.emptyFound": 30, "message.emptyNone": 30, "message.refused.text": 20 };
  const walkCopy = (o, at) => Object.entries(o).flatMap(([k, v]) => (k === "$about" ? [] : typeof v === "string" ? [[`${at}${k}`, v]] : walkCopy(v, `${at}${k}.`)));
  for (const [k, v] of walkCopy(tokens.copy.canvas, "")) assert.ok(words(v) <= (EXCEPT[k] ?? 14), `copy.canvas.${k}: ${words(v)} words`);
});

test("every number stays reachable (UX-V2 §12, §14.4): counts, ratios, ranges and full labels, shown or one click away", () => {
  let agents = 0;
  for (const c of ALL.filter((x) => x.contract === "snapshot" && x.valid && !x.name.includes("hostile"))) {
    const d = decode(c);
    if (d.display !== "ok" && d.display !== "stale") continue;
    d.agents.forEach((a, agent) => {
      agents++;
      const reach = (page) => {
        const tree = openAll(d, ui(c, page, { agent }));
        return [...allText(tree), ...nodes(tree).flatMap(({ n }) => [n.attrs["aria-label"], n.attrs.title].filter(Boolean))].join("\n");
      };
      const finding = reach("verdict"), compare = reach("compare"), timeline = reach("timeline");
      for (const m of a.metrics) {
        for (const v of [`${num(m.recent.k)} / ${num(m.recent.n)}`, `${num(m.baseline.k)} / ${num(m.baseline.n)}`]) assert.ok(compare.includes(v), `${c.name}/${a.id} Compare: ${m.id} ${v}`);
        if (m.eligible && m.ratio !== null) assert.ok(compare.includes(`×${m.ratio.toFixed(2)}`), `${c.name}/${a.id}: ${m.id} ratio`);
        if (m.eligible && m.range) assert.ok(compare.includes(`×${m.range[0].toFixed(2)}–×${m.range[1].toFixed(2)}`), `${c.name}/${a.id}: ${m.id} range`);
        if ((m.role === "vote" || m.role === "support") && a.reason !== "calibration_pending") assert.ok(finding.includes(`${num(m.recent.k)} / ${num(m.recent.n)}`), `${c.name}/${a.id} Finding: ${m.id}`);
      }
      for (const e of a.timeline) assert.ok(timeline.includes(e.label), `${c.name}/${a.id} Timeline: "${e.label}"`);
      // every day of the Finding's strip: in Daily counts (k and n) and the strip's text description
      if (a.strip && a.windows) for (const r of a.strip.days.filter((x) => x.d >= a.windows.recent.from)) {
        assert.ok(finding.includes(`${fdate(r.d)}: `) && finding.includes(num(r.n)), `${c.name}/${a.id}: day ${r.d}`);
      }
    });
  }
  assert.ok(agents >= 4, `${agents} agents checked`);
});
