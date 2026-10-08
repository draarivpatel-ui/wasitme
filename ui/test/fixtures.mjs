// The canvas's test inputs: every golden in contract/fixtures/manifest.json (synthetic, never engine output, never
// real logs). Snapshot goldens are used as they are. Glance goldens are LIFTED to the snapshot's shape here (test code
// only; the page itself accepts only wasitme.snapshot/1): the schema id is swapped only when it is exactly the glance
// id (so a mismatched id stays mismatched and privacy tampering stays intact), and the snapshot-only fields a glance
// can't carry are filled with the contract generator's own constants (contract/fixtures/generate.mjs snapshotAgent:
// the two windows, the observation note, health/calibration) plus the disclaimer, which the contract fixes for
// none/you/agent. Everything else (metrics, timeline) the page derives from the glance's own topMetrics and events.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UI = dirname(dirname(fileURLToPath(import.meta.url)));
export const ROOT = dirname(UI);
export const FIX = join(ROOT, "contract", "fixtures");

const DISCLAIMER = "These indicators don't measure answer quality. Evidence, not proof.";
const UNSEEN = "Sessions on other machines aren't visible.";
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function liftAgent(a) {
  if (!isObj(a)) return a;
  const out = { ...a };
  const n = isObj(a.n) ? a.n : null;
  if (a.calibrated === true && n) {
    out.windows = {
      recent: { from: "2026-09-20", to: "2026-10-03", days: 14, exchanges: n.exchanges, sessions: n.sessions, sessionDays: n.sessionDays },
      baseline: { from: "2026-08-23", to: "2026-09-19", days: 28, exchanges: n.exchanges * 2 - 37, sessions: n.sessions + 3, sessionDays: n.sessionDays * 2 - 5 },
    };
  }
  out.observation = { fullyObservedDays: a.calibrated === true ? 14 : 0, partiallyObservedDays: a.calibrated === true ? 0 : 9, note: UNSEEN };
  out.disclaimer = ["none", "you", "agent"].includes(a.state) ? DISCLAIMER : null;
  return out;
}

export function liftGlance(g) {
  if (!isObj(g) || g.schema !== "wasitme.glance/1") return g;
  const agents = Array.isArray(g.agents) ? g.agents : [];
  const ids = agents.map((a) => (isObj(a) ? a.agent : null));
  return {
    ...g,
    schema: "wasitme.snapshot/1",
    agents: agents.map(liftAgent),
    health: {
      sources: [
        { agent: "claude-code", found: true, files: 22, badLines: 1, truncatedTail: 1, duplicates: 2214, unknownTypes: { relocated: 2 }, firstDay: "2026-07-24", lastDay: "2026-10-04", error: null },
        ids.includes("codex")
          ? { agent: "codex", found: true, files: 31, badLines: 0, truncatedTail: 0, duplicates: 0, unknownTypes: { "codex:event_msg:future_event_kind": 1 }, firstDay: "2026-09-02", lastDay: "2026-10-03", error: null }
          : { agent: "codex", found: false, files: 0, badLines: 0, truncatedTail: 0, duplicates: 0, unknownTypes: {}, firstDay: null, lastDay: null, error: "not_found" },
      ],
      parserVersions: { toolErrors: 1, research: 1, friction: 1, events: 1 },
      sandbox: true,
      paused: [],
    },
    calibration: {
      artifactDate: "2026-10-04", methodId: "session-day-t99-cr2",
      agents: [{ agent: "claude-code", calibrated: true, sequences: 1000 }, { agent: "codex", calibrated: false, sequences: 0 }],
    },
  };
}

/** [{ name, file, contract, valid, now, expect, raw, doc }] for every manifest entry; `doc` is what the page gets. */
export function cases() {
  const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));
  return manifest.fixtures.map((f) => {
    const raw = JSON.parse(readFileSync(join(FIX, f.file), "utf8"));
    return {
      name: f.file.replace(/\.json$/, "").replace("/", "-"),
      file: f.file, contract: f.contract, valid: f.valid, now: f.now, expect: f.expect, raw,
      doc: f.contract === "glance" ? liftGlance(raw) : raw,
    };
  });
}

/**
 * Test-only: an agent at its real update cadence (the synthetic both-agents corpus had 23 Claude Code updates in six
 * weeks), so chart labels have to give way. The insufficient-timeline golden plus an update every two days across the
 * timeline's six weeks (two of them on consecutive days, as real point releases land) and two more changes on your side.
 * Markers are assigned by the page's decoder, as for every golden.
 */
export function denseUpdates() {
  const c = cases().find((x) => x.file === "snapshot/insufficient-timeline.json");
  const doc = JSON.parse(JSON.stringify(c.doc));
  const a = doc.agents[0];
  const day = (n) => new Date(Date.parse("2026-08-23T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const extra = [];
  let v = 230;
  for (let i = 0; i < 21; i++) {
    const d = day(i * 2);
    extra.push({ id: `dense-a${i}`, t: `${d}T15:00:00Z`, day: d, kind: "version", side: "agent", strength: "routine", provenance: "log_field",
      label: `Claude Code 2.1.${v} → 2.1.${v + 3}`, from: `2.1.${v}`, to: `2.1.${v + 3}`, new: false });
    if (i === 6 || i === 15) extra.push({ id: `dense-b${i}`, t: `${day(i * 2 + 1)}T15:00:00Z`, day: day(i * 2 + 1), kind: "version", side: "agent", strength: "routine",
      provenance: "log_field", label: `Claude Code 2.1.${v} → 2.1.${v + 4}`, from: `2.1.${v}`, to: `2.1.${v + 4}`, new: false });
    v += 3;
  }
  extra.push({ id: "dense-y1", t: "2026-09-01T10:00:00Z", day: "2026-09-01", kind: "model", side: "you", strength: "strong", provenance: "settings_snapshot", label: "Model changed", from: "a", to: "b", new: false });
  extra.push({ id: "dense-y2", t: "2026-09-02T10:00:00Z", day: "2026-09-02", kind: "instructions", side: "you", strength: "strong", provenance: "settings_snapshot", label: "Instructions changed", from: "4", to: "6", new: false });
  a.timeline = [...a.timeline, ...extra].sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  return { ...c, name: "dense-updates", file: "(test) snapshot/insufficient-timeline.json + 23 agent updates", raw: null, doc };
}

/**
 * Test-only: changes at the rate a busy setup really makes them (the Finding chart's marker rows ran into one unreadable
 * strip at this rate, 2026-10-07): 44 changes on your side over the Finding's 28 days (MCP servers and permission mode
 * mostly, effort and model; up to four on one day), 20 of unknown origin, and 30 agent updates over the Timeline's six
 * weeks (two on some days). Hand-built and synthetic, like every fixture; markers are assigned by the page's decoder.
 * `base` "you" builds on the you-and-codex golden instead, whose open candidate (your effort change, Sep 21) then sits
 * on a crowded day: the one badge that must keep its own number.
 */
export function crowdedChanges(base = "insufficient") {
  const file = base === "you" ? "snapshot/you-and-codex.json" : "snapshot/insufficient-timeline.json";
  const c = cases().find((x) => x.file === file);
  const doc = JSON.parse(JSON.stringify(c.doc));
  const a = doc.agents[0];
  const day = (n) => new Date(Date.parse("2026-08-23T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const at = (d, h, m) => `${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const keep = new Set(a.candidates.map((x) => x.event));
  const out = a.timeline.filter((e) => keep.has(e.id));
  // your side: per day over the Finding's 28 days (Sep 6 – Oct 3, days 14..41 of the six weeks)
  const yours = [1, 2, 0, 3, 1, 2, 0, 1, 4, 2, 1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 1, 0, 2, 1, 3, 2, 1, 3];
  const KINDS = ["mcp", "mode", "mcp", "mode", "effort", "mcp", "model", "mode"];
  const label = (kind, i) => kind === "mcp" ? (i % 2 ? ["MCP server removed", "4", "3"] : ["MCP server added", "3", "4"])
    : kind === "mode" ? (i % 2 ? ["Permission mode acceptEdits → default", "acceptEdits", "default"] : ["Permission mode default → acceptEdits", "default", "acceptEdits"])
      : kind === "effort" ? (i % 2 ? ["Effort medium → high", "medium", "high"] : ["Effort high → medium", "high", "medium"])
        : (i % 2 ? ["Model sonnet → opus", "sonnet", "opus"] : ["Model opus → sonnet", "opus", "sonnet"]);
  let n = 0;
  yours.forEach((count, i) => {
    for (let j = 0; j < count; j++, n++) {
      const kind = KINDS[n % KINDS.length], [text, from, to] = label(kind, n), d = day(14 + i);
      out.push({ id: `crowd-y${n}`, t: at(d, 9 + 2 * j, 10), day: d, kind, side: "you", strength: "strong", provenance: kind === "mcp" ? "settings_snapshot" : "command",
        label: text, from, to, new: false });
    }
  });
  // origin unknown: 20 over the same 28 days (two on the last)
  const unknown = [0, 1, 3, 4, 6, 8, 9, 11, 12, 14, 15, 17, 19, 20, 22, 23, 25, 26, 27, 27];
  unknown.forEach((i, k) => {
    const kind = ["model", "effort", "mode"][k % 3], [text, from, to] = label(kind, k), d = day(14 + i);
    out.push({ id: `crowd-u${k}`, t: at(d, 8, 5 + k), day: d, kind, side: "unknown", strength: "weak", provenance: "log_field",
      label: `${text} (no command recorded)`.slice(0, 60), from, to, new: false });
  });
  // the agent: 30 updates over the six weeks, every day or two, two on some days
  const agentDays = Array.from({ length: 28 }, (_, k) => Math.floor(k * 1.5));
  agentDays.push(10, 33);
  agentDays.sort((x, y) => x - y);
  let v = 240;
  agentDays.forEach((i, k) => {
    const d = day(i), to = v + 1 + (k % 2);
    out.push({ id: `crowd-a${k}`, t: at(d, 15, 30 + k % 20), day: d, kind: "version", side: "agent", strength: "routine", provenance: "log_field",
      label: `Claude Code 2.1.${v} → 2.1.${to}`, from: `2.1.${v}`, to: `2.1.${to}`, new: false });
    v = to;
  });
  a.timeline = out.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  a.events = a.timeline.slice(-5).reverse().map((e) => ({ day: e.day, kind: e.kind, side: e.side, strength: e.strength, label: e.label, new: e.new }));
  return { ...c, name: `crowded-${base}`, file: `(test) ${file} + ${out.length - keep.size} changes`, raw: null, doc };
}

/** The pairs the design screens were drawn for (design/system/screens/*.png ↔ a golden + page + agent). */
export const DESIGN_PAIRS = [
  { screen: "cc-insufficient", file: "snapshot/insufficient-timeline.json", page: "verdict", agent: 0 },
  { screen: "cc-none", file: "glance/none-verdict.json", page: "verdict", agent: 0 },
  { screen: "cc-unclear", file: "glance/unclear-verdict.json", page: "verdict", agent: 0 },
  { screen: "cc-you", file: "snapshot/you-and-codex.json", page: "verdict", agent: 0 },
  { screen: "cc-agent", file: "snapshot/agent-by_elimination.json", page: "verdict", agent: 0 },
  { screen: "cc-codex-insufficient", file: "snapshot/you-and-codex.json", page: "verdict", agent: 1 },
  { screen: "cc-timeline", file: "snapshot/insufficient-timeline.json", page: "timeline", agent: 0 },
  { screen: "cc-compare", file: "snapshot/you-and-codex.json", page: "compare", agent: 0 },
  { screen: "cc-setup", file: "snapshot/insufficient-timeline.json", page: "setup", agent: 0 },
  { screen: "report-agent", file: "snapshot/agent-by_elimination.json", page: "report", agent: 0 },
];

export const PAGE_IDS = ["timeline", "verdict", "compare", "setup", "report", "sources", "settings"];
