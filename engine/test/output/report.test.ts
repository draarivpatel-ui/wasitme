/**
 * The shareable evidence report (WP-30): Markdown goldens, the share rules (PRIVACY.md "What a report reveals":
 * day-level dates, no ids, the fixed sentences), the single-file HTML (no script, no URL, the CSP hash recomputed from
 * the emitted bytes) and hostile text.
 * Regenerate goldens with WASITME_UPDATE_GOLDENS=1 and review the diff of engine/test/output/goldens/report/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { DISCLAIMER, lintCopy } from "../../src/contract/check.js";
import { coerceDoc } from "../../src/output/doc.js";
import { renderHtml, renderMarkdown, styleText } from "../../src/output/report.js";
import { tokensBanned } from "../words/helpers.js";
import { CASES, docOf, GOLDENS, NOW_MS, outputsOf, readJson, ROOT, UPDATE } from "./cases.js";

function golden(path: string, text: string): void {
  if (UPDATE) {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  assert.ok(existsSync(path), `missing golden ${path.slice(ROOT.length)} (run with WASITME_UPDATE_GOLDENS=1)`);
  assert.equal(text, readFileSync(path, "utf8"), `golden ${path.slice(ROOT.length)} differs`);
}

for (const c of CASES) {
  test(`report ${c.name}: Markdown golden, share rules and lints`, () => {
    const doc = docOf(c.name);
    const md = renderMarkdown(doc);
    golden(`${GOLDENS}report/${c.name}.md`, md);
    // the fixed sentences every export carries
    assert.ok(md.includes(DISCLAIMER), "the fixed disclaimer");
    assert.match(md, /One person’s logs on one Mac\./);
    assert.match(md, /Generated locally by wasitme 0\.1\.0 on Oct 4 · numbers only: no prompts, code or paths · method: docs\/METHOD\.md/);
    // day-level dates only, no ids, no seed claim, no false-rate claim, no verdict word
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}|\d{2}:\d{2}:\d{2}|\+\d{2}:\d{2}|\bZ\b/.test(md), "no timestamps or zone offsets");
    assert.ok(!/\b(?:e|d|t|g|x)-[0-9a-f]{6,}|\bp-[0-9a-f]{12}\b|src-[0-9a-f]{24}/.test(md), "no ids");
    assert.ok(!/\bseed\b/i.test(md));
    assert.ok(!/\bverdicts?\b/i.test(md));
    assert.deepEqual(lintCopy(md.replace(/\n/g, " ")), [], "copy lint");
    for (const line of md.split("\n")) assert.deepEqual(tokensBanned(line), [], `tokens.json banned list: ${line}`);
    assert.ok(md.endsWith("\n") && !md.endsWith("\n\n"));
  });
}

test("report: every state leads with the deck (the one-sentence finding) and gives the note (the evidence) after it (D67)", () => {
  const you = renderMarkdown(docOf("you"));
  assert.match(you, /### wasitme report: your side changed \(Claude Code\)/);
  assert.match(you, /`■──` \*\*Your side\.\*\* Your numbers moved around the time of your model change from m1 to m2 \(Sep 24\)\.\n\nTool errors \(×2\.4\) and edits without reading first \(×1\.7\) rose; /);
  const early = renderMarkdown(docOf("insufficient"));
  assert.match(early, /### wasitme report: too early to tell \(Claude Code\)/);
  assert.match(early, /\*\*Too early to tell\.\*\* wasitme needs \d+ more days of history before it can compare\.\n\nThe shortest comparison puts /);
  assert.ok(!/At your pace|may not unlock/.test(early), "D66: no projected dates");
  // No comparison yet: the table says so once (under it), and its rows keep only the status word.
  assert.equal(early.split("Change and range show once there is enough history to compare.").length, 2, "said exactly once");
  assert.doesNotMatch(early, /needs more history/);
  assert.match(early, /\| Reads per edit \| [\d,]+ \/ [\d,]+ \| [\d,]+ \/ [\d,]+ \| {2}\| {2}\| not yet \|/);
  const html = renderHtml(docOf("insufficient"));
  assert.equal(html.split("Change and range show once there is enough history to compare.").length, 2, "HTML: said exactly once");
  assert.doesNotMatch(html, /needs more history/);
  const timeline = renderMarkdown(docOf("timeline-only"));
  assert.match(timeline, /Findings for Claude Code are off until wasitme's tests pass/);
});

test("report: the metrics table has the app's columns, counts as events / opportunities, ranges rounded outward", () => {
  const md = renderMarkdown(docOf("you"));
  assert.match(md, /\| signal \| recent \| before \| change \| range \| status \|\n\|---\|---:\|---:\|---:\|---\|---\|/);
  assert.match(md, /\| Tool errors \(excl\. commands\) \| [\d,]+ \/ [\d,]+ \| [\d,]+ \/ [\d,]+ \| ×\d\.\d\d \| ×\d\.\d\d–×\d\.\d\d \| moved, more \|/);
  assert.match(md, /Counts are events \/ opportunities per window\. Range: where the ratio could be at this volume \(see docs\/METHOD\.md\)\./);
  // The limit is a voting indicator's that did not move ("might": a limit, not a promise); never a moved or a context row's.
  assert.match(md, /At this volume, changes under ×\d\.\d in reads per edit might not show\./);
  assert.doesNotMatch(md, /wouldn't show/);
});

test("report: --agent keeps one agent; nothing else of the other leaks in", () => {
  const snap = readJson(`${ROOT}contract/fixtures/snapshot/you-and-codex.json`);
  const doc = coerceDoc(snap, Date.parse(snap.generatedAt) + 60_000);
  assert.equal(doc.agents.length, 2);
  const both = renderMarkdown(doc);
  const codex = renderMarkdown(doc, { agent: "codex" });
  assert.match(both, /\(Claude Code\)/);
  assert.match(both, /\(Codex\)/);
  assert.match(codex, /\(Codex\)/);
  assert.ok(!codex.includes("(Claude Code)"));
  assert.match(renderMarkdown(doc, { agent: "nobody" }), /No findings to report yet/);
});

// ───────────────────────────── HTML ─────────────────────────────

test("report HTML: one file, no script, no URL, CSP with the style element's own sha256 (recomputed from the emitted bytes)", () => {
  for (const c of CASES) {
    const html = renderHtml(docOf(c.name));
    const style = /<style>([\s\S]*?)<\/style>/.exec(html);
    assert.ok(style !== null, "one style element");
    assert.equal(style![1], styleText());
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    assert.ok(meta !== null);
    const want = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(style![1]!, "utf8").digest("base64")}'; font-src data:`;
    assert.equal(meta![1], want, "the CSP names the hash of the exact style text");
    const body = html.replace(/<style>[\s\S]*?<\/style>/, "");
    assert.ok(!/<script|javascript:|\bon[a-z]+\s*=|<link|<img|<iframe|<object|<embed|<form|<base/i.test(body), `${c.name}: no script, link, image or handler`);
    assert.ok(!/https?:|\/\/[a-z]/i.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), `${c.name}: no URL outside the stylesheet`);
    assert.ok(!/@import|url\((?!data:font\/woff2;base64,)/.test(style![1]!), `${c.name}: the stylesheet fetches nothing`);
    assert.ok(html.startsWith("<!doctype html>\n<html lang=\"en\">"));
    assert.ok(html.includes(DISCLAIMER.replace("'", "&#39;")) || html.includes(DISCLAIMER), "disclaimer present");
    assert.ok(html.length < 400_000, "a report is small: the fonts are the bulk");
  }
});

test("report HTML: golden of the structure (the stylesheet is held by the design-sync test)", () => {
  const html = renderHtml(docOf("agent")).replace(/<style>[\s\S]*?<\/style>/, "<style>…</style>").replace(/content="default-src 'none'; style-src 'sha256-[^']+'/, "content=\"default-src 'none'; style-src 'sha256-…'");
  golden(`${GOLDENS}report/agent.html`, html);
});

// ───────────────────────────── hostile text ─────────────────────────────

test("report: hostile labels cannot become Markdown links, images, HTML or terminal escapes", () => {
  const manifest = readJson(`${ROOT}contract/fixtures/manifest.json`);
  const entry = manifest.fixtures.find((f: any) => f.file === "glance/hostile-labels.json");
  const raw = readJson(`${ROOT}contract/fixtures/glance/hostile-labels.json`);
  const doc = coerceDoc(raw, Date.parse(entry.now));
  const md = renderMarkdown(doc);
  const html = renderHtml(doc);
  // no raw HTML or markup from the data: every < > [ ] ` * _ | # is escaped in Markdown
  assert.ok(!/(?<!\\)<(script|img)/i.test(md), "no raw tags in Markdown");
  assert.ok(!/(?<!\\)\[click\]\(javascript:/.test(md), "no live link");
  assert.ok(!/(?<!\\)\]\(/.test(md.replace(/\\\]\(/g, "")), "no unescaped link syntax");
  for (const out of [md, html]) {
    assert.ok(!out.includes("\x1b"), "no escape character");
    assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff\u0085]/.test(out), "no bidi or invisible character");
  }
  assert.ok(!/<script|<img|onerror=/i.test(html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/&lt;[^&]*&gt;/g, "")), "HTML holds the data only as escaped text");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;|alert\(1\)/);
});

test("report: Markdown escaping covers every character that could start markup", () => {
  const raw = { ...outputsOf("you").snapshot };
  raw.agents = raw.agents.map((a: any) => ({ ...a, because: "x <b>*bold*</b> _it_ `code` [l](http://u) | pipe # head ~~s~~ &amp;", timeline: a.timeline.map((e: any) => ({ ...e, label: "a|b <i>c</i>" })) }));
  const md = renderMarkdown(coerceDoc(raw, NOW_MS));
  assert.ok(md.includes("x \\<b\\>\\*bold\\*\\</b\\> \\_it\\_ \\`code\\` \\[l\\](http://u) \\| pipe \\# head \\~\\~s\\~\\~ \\&amp;"));
  assert.ok(md.includes("a\\|b \\<i\\>c\\</i\\>"));
});

test("report: an out-of-date or failed-scan document says so at the top of every format", () => {
  const stale = docOf("you", "timeline", NOW_MS + 3 * 3600_000);
  assert.equal(stale.display, "stale");
  const md = renderMarkdown(stale);
  assert.match(md, /^> \*\*Out of date: these results were last updated on Oct 4\. Run wasitme scan to refresh them before sharing\.\*\*\n/);
  assert.match(renderHtml(stale), /<p class="banner">Out of date: these results were last updated on Oct 4\./);
  const failed = coerceDoc({ ...outputsOf("you").snapshot, scanOk: false, scanError: "timeout" }, NOW_MS);
  assert.match(renderMarkdown(failed), /^> \*\*The last scan failed \(timeout\); this is the last good result\.\*\*\n/);
  assert.ok(!renderMarkdown(docOf("you")).includes("Out of date"), "a fresh report has no banner");
});
