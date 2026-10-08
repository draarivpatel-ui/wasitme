/**
 * "Why this finding": one sentence per decision-table row the engine checked (METHOD.md §11), saying what decided that
 * row — the condition that failed, or, for the matched row, why it holds. Built from the engine's structured trace
 * (WP-21 `TraceRow`: condition ids, events, metrics, details); never from log text.
 *
 * Collapsing: when the evaluation is not "changed", rows 4–11 all stop at the same `changed` condition. Row 4 says so
 * once and rows 5–11 are left out (CONTRACT allows any ascending subset that ends at the matched row).
 */
import type { TraceRow } from "../analysis/attribution/types.js";
import { TIERS } from "../analysis/metrics/windows.js";
import type { Facts } from "./facts.js";
import { cap, day, fit, list, mde as mdeText, plural, ratio as ratioText } from "./format.js";
import { agentName, agentPhrases, metricWords, prose, youPhrase } from "./names.js";

export interface TraceStepWords { row: number; matched: boolean; text: string }

const LIMIT = 200;

/**
 * The voting indicators of these families by name ("reads per edit and edits without reading first"), or null when the
 * facts list none. A sentence names the indicators, not their family ("No research indicator…" said nothing a reader
 * could look up). Names are plural noun phrases, so the sentence's verb is plural.
 */
function familyNames(f: Facts, fams: readonly string[]): string | null {
  const names = f.metrics.filter((m) => m.role === "vote" && fams.includes(m.family)).map((m) => metricWords(m.id).name);
  return names.length === 0 ? null : list([...new Set(names)]);
}

function ratioList(f: Facts, ids: readonly string[]): string {
  return list(ids.map((id) => {
    const m = f.metrics.find((x) => x.id === id);
    const w = metricWords(id).name;
    return m?.ratio != null ? `${w} ${ratioText(m.ratio)}` : w;
  }));
}

const WORKLOAD_TEXT: Readonly<Record<string, string>> = {
  projects_differ: "your projects differ too much between the two windows to compare",
  standardised_lost: "compared like with like (same projects and setup), the shift doesn't hold",
  projects_disagree: "the shift doesn't show in most of your projects",
};

export function workloadText(reason: string | undefined): string {
  return (reason !== undefined && WORKLOAD_TEXT[reason]) || "your mix of projects and setups moved too";
}

/** Why the onset window isn't fully observed; `its` phrases it for a sentence that already named the window. */
function observedText(f: Facts, its = false): string {
  const A = agentName(f.agent);
  const o = f.observation;
  if (o.partialByDesign) return `${A} can't be fully observed: it has no session hooks`;
  const total = o.partiallyObservedDays + o.fullyObservedDays;
  const where = its ? "its" : "the";
  const tail = its ? "" : " in the onset window";
  if (o.fullyObservedDays === 0) return `none of ${where} ${plural(total, "day")}${tail} ${total === 1 ? "was" : "were"} fully observed`;
  return `${o.partiallyObservedDays} of ${where} ${plural(total, "day")}${tail} ${o.partiallyObservedDays === 1 ? "wasn't" : "weren't"} fully observed`;
}

const BOUNDARY_TEXT: Readonly<Record<string, string>> = {
  no_boundary: "No single update lines up with the start of the shift.",
  several_boundaries: "More than one update landed in the onset window.",
  shift_not_shown: "Comparing the week before the update with the week from it on doesn't show the shift by itself.",
  projects: "The shift around the update doesn't show in enough of your projects.",
  not_observed: "The days around the update weren't fully observed.",
};

function candidate(f: Facts, id: string | undefined) {
  return id === undefined ? undefined : f.candidates.find((c) => c.event === id);
}

function windowText(f: Facts): string {
  return f.onset === null ? "" : ` (${day(f.onset.from, f.today)}–${day(f.onset.to, f.today)})`;
}

/** The sentence for one checked row. */
export function traceText(r: TraceRow, f: Facts): string {
  const A = agentName(f.agent);
  const last = r.conditions[r.conditions.length - 1];
  const holds = last?.holds === true;
  const id = last?.id;
  const evs = (last?.events ?? []).map((e) => candidate(f, e)).filter((c) => c !== undefined);
  const firstDate = (c: { day: string | null } | undefined) => (c?.day ? ` (${day(c.day, f.today)})` : "");

  if (id === "changed" && !holds) {
    if (f.fragileDays) return "The move rests on one of its three most influential days, so it doesn't count as a change.";
    return "Not a change by wasitme's rule, which needs indicators of 2 kinds moving the same way.";
  }
  switch (r.row) {
    case 1:
      return holds
        ? fit(LIMIT, `Findings for ${A} are off until wasitme's tests pass for ${A} logs.`, "Findings are off until wasitme's tests pass for these logs.")
        : fit(LIMIT, `Findings for ${A} are calibrated: wasitme's tests pass for ${A} logs.`, "Findings are calibrated for these logs.");
    case 2: {
      if (!holds) return "Each kind of indicator has one with enough data.";
      if (f.tier === null) {
        return `No comparison yet: the shortest one needs ${TIERS[0]!.historyDays} days of history, and there ${f.history.days === 1 ? "is" : "are"} ${plural(f.history.days, "day")}.`;
      }
      const fams = Array.isArray(last?.detail?.families) ? (last!.detail!.families as string[]) : [];
      const names = familyNames(f, fams);
      return names !== null
        ? fit(LIMIT, `${cap(names)} don't have enough data yet.`, "One kind of indicator doesn't have enough data yet.")
        : "One kind of indicator doesn't have enough data yet.";
    }
    case 3:
      return holds && f.mixed !== null
        ? fit(LIMIT, `Indicators moved in opposite directions: ${ratioList(f, f.mixed.worse)} against ${ratioList(f, f.mixed.better)}.`, "Indicators moved in opposite directions.")
        : "No indicators moved in opposite directions.";
    case 4:
      return holds
        ? fit(LIMIT, `Your work changed too: ${workloadText(f.workload[0])}.`, "Your work changed too, and the shift doesn't hold once that is accounted for.")
        : "The shift holds when your projects and setup are compared like with like.";
    case 5:
      return holds
        ? fit(LIMIT, `The logs don't say who made ${plural(evs.length || 1, "change")} in the onset window${windowText(f)}.`, "The logs don't say who made a change in the onset window.")
        : "Every change in the onset window has a known side.";
    case 6: {
      if (id === "you_strong_open" && !holds) return "Nothing on your side is open in the onset window.";
      if (id === "agent_strong" && !holds) return "Nothing on the agent's side but routine updates is in the onset window.";
      const you = f.candidates.find((c) => c.class === "you_strong" && c.status === "open");
      const ag = f.candidates.find((c) => c.class === "agent_strong");
      return fit(LIMIT,
        `A change on your side (${you ? youPhrase(you, f.agent, false) : "a recorded change"}) and one on the agent's side (${agentPhrases(ag?.tripwire ?? null, f.agent).short}) are both in the onset window.`,
        "A change on your side and one on the agent's side are both in the onset window.");
    }
    case 7: {
      if (id === "you_strong_open" && !holds) {
        const ruled = f.candidates.filter((c) => c.class === "you_strong" && c.status === "ruled_out").length;
        return ruled > 0
          ? `${ruled === 1 ? "Your change in the onset window was" : `Your ${ruled} changes in the onset window were`} ruled out: the shift also shows without ${ruled === 1 ? "it" : "them"}.`
          : "Nothing strong on your side is in the onset window.";
      }
      if (id === "no_agent_strong" && !holds) return "A change on the agent's side is in the onset window too.";
      const you = evs[0] ?? f.candidates.find((c) => c.class === "you_strong" && c.status === "open");
      return fit(LIMIT,
        `${cap(you ? youPhrase(you, f.agent, true) : "a change on your side")}${firstDate(you)} falls in the onset window and wasn't ruled out; on the agent's side there are only routine updates.`,
        `${cap(you ? youPhrase(you, f.agent, false) : "a change on your side")}${firstDate(you)} falls in the onset window and wasn't ruled out.`,
        "A change on your side falls in the onset window and wasn't ruled out.");
    }
    case 8: {
      if (id === "agent_strong" && !holds) return "Nothing on the agent's side but routine updates is in the onset window.";
      if (id === "no_you_strong_open" && !holds) return "A change on your side is still open in the onset window.";
      const ag = evs[0] ?? f.candidates.find((c) => c.class === "agent_strong");
      const tail = f.blindSpot ? "; some days weren't fully observed" : "";
      const when = ag?.day ? `, ${day(ag.day, f.today)}` : "";
      return fit(LIMIT,
        `A change on the agent's side (${agentPhrases(ag?.tripwire ?? null, f.agent).short}${when}) falls in the onset window, and nothing on your side is open there${tail}.`,
        `A change on the agent's side falls in the onset window, and nothing on your side is open there${tail}.`);
    }
    case 9: {
      if (id === "only_routine_or_weak" && !holds) return "Something other than routine updates or minor settings is in the onset window.";
      if (id === "fully_observed" && !holds) return fit(LIMIT, `${cap(observedText(f))}.`, "Some days in the onset window weren't fully observed.");
      if (id === "version_boundary" && !holds) {
        const why = typeof last?.detail?.reason === "string" ? last.detail.reason : "";
        return BOUNDARY_TEXT[why] ?? "The version-boundary test doesn't pass.";
      }
      const vb = f.candidates.find((c) => c.test === "version_boundary");
      const v = vb ? prose(vb.to) : null;
      const p = f.boundary?.projects ?? null;
      return fit(LIMIT,
        `Only routine updates or minor settings in the onset window, every day fully observed, and the shift starts at the ${v !== null ? `${v} ` : ""}update${p !== null ? ` in ${p} projects` : ""}.`,
        "Only routine updates or minor settings in the onset window, every day fully observed, and the shift starts at the update.");
    }
    case 10:
      if (id === "fully_observed" && !holds) return fit(LIMIT, `${cap(observedText(f))}.`, "Some days in the onset window weren't fully observed.");
      if (id === "only_routine_or_weak" && !holds) return "Something other than routine updates or minor settings is in the onset window.";
      return "Only routine updates or minor settings in the onset window, on fully observed days.";
    case 11:
      if (!holds) return "Every day in the onset window was fully observed.";
      return fit(LIMIT, `Only routine updates or minor settings in the onset window, and ${observedText(f, true)}.`,
        "Only routine updates or minor settings in the onset window, and some of its days weren't fully observed.");
    case 12: {
      if (holds && f.single !== null) {
        return `Exactly one indicator moved (${metricWords(f.single.metric).name} ${ratioText(f.single.ratio)}), and it stands out even with all the indicators checked together.`;
      }
      const kind = typeof last?.detail?.kind === "string" ? last.detail.kind : "";
      switch (kind) {
        case "none_material": return "No indicator moved on its own.";
        case "several_not_changed": return "Indicators of one kind moved, but not two kinds together.";
        case "low_df": return "One indicator moved, but too few independent days back it.";
        case "fails_holm": return "One indicator moved, but not clearly enough with all the indicators checked together.";
        case "changed": return "Several indicators moved together, so this isn't a single-indicator case.";
        case "mixed": return "Indicators moved in opposite directions, so this isn't a single-indicator case.";
        default: return "Not a single-indicator case.";
      }
    }
    case 13: {
      if (id === "no_material" && !holds) return "An indicator moved, so wasitme won't say there is no detectable change.";
      if (id === "sensitive_each_family" && !holds) {
        const fams = Array.isArray(last?.detail?.families) ? (last!.detail!.families as string[]) : [];
        const names = familyNames(f, fams);
        return names !== null
          ? fit(LIMIT, `${cap(names)} can't rule out a doubling yet.`, "One kind of indicator can't rule out a doubling yet.")
          : "One kind of indicator can't rule out a doubling yet.";
      }
      const sens = f.metrics.filter((m) => m.role === "vote" && m.eligible && m.sensitive && m.usable && m.mde !== null);
      const x = sens.length > 0 ? Math.max(...sens.map((m) => m.mde!)) : null;
      return x !== null
        ? `Nothing moved, and each kind of indicator would have shown a change bigger than about ${mdeText(x)}.`
        : "Nothing moved, and each kind of indicator was sensitive enough to show a change.";
    }
    case 14:
      return "Not enough data or sensitivity yet to say more.";
    default:
      return holds ? "This row matched." : "This row didn't match.";
  }
}

/** The trace steps (collapsed as described in the file header), each text ≤ 200. */
export function traceWords(f: Facts): TraceStepWords[] {
  const out: TraceStepWords[] = [];
  let changedShown = false;
  for (const r of f.trace) {
    const only = r.conditions.length === 1 ? r.conditions[0] : undefined;
    const notChanged = only !== undefined && only.id === "changed" && !only.holds;
    if (notChanged && !r.matched) {
      if (changedShown) continue;
      changedShown = true;
    }
    const text = fit(LIMIT, traceText(r, f), r.matched ? "This row matched." : "This row didn't match.");
    // Two rows that stop at the same condition (e.g. rows 9 and 10 on a partially observed window) say it once.
    if (!r.matched && out.length > 0 && out[out.length - 1]!.text === text) continue;
    out.push({ row: r.row, matched: r.matched, text });
  }
  return out;
}
