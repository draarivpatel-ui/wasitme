/**
 * Pure timeline of one exchange: millisecond offsets from the prompt for every record the renderers
 * emit. Both renderers and the planner (which needs the total span to place exchanges in time) call
 * this, so durations in the truth file are exactly what the files show.
 */
import type { Exchange } from "./model.js";
import type { AgentName } from "./params.js";

export interface StepLayout {
  notifOff?: number;
  metaOff?: number;
  compactOff?: number;
  retryOffs: number[];
  /** Request sent. */
  startOff: number;
  /** Response complete (assistant records are spread over startOff..endOff). */
  endOff: number;
  resultOffs: number[];
}

export interface QueuedLayout { enqOff: number; deliverOff: number }

export interface Layout {
  steps: StepLayout[];
  queued: QueuedLayout[];
  interruptOff?: number;
  /** Last activity record (turn_duration / hook summary). Also the exchange's planned duration. */
  endOff: number;
}

/**
 * Offset (ms from the prompt, always negative) of the record that evidences the `index`-th user-typed
 * change of an exchange: Claude's `<command-name>` record, Codex's `thread_settings_applied` (one record
 * for all changes of the exchange). The renderers place the record there and the truth file reports the
 * same instant as the event's `commandAt`, so the two cannot drift apart.
 */
export function commandOffsetMs(agent: AgentName, index: number): number {
  return agent === "claude-code" ? -29 + index * 10 : -5;
}

export function layoutExchange(ex: Exchange): Layout {
  let cursor = ex.promptLeadMs;
  const steps: StepLayout[] = [];
  const queued: QueuedLayout[] = ex.queued.map(() => ({ enqOff: 0, deliverOff: 0 }));

  ex.steps.forEach((step, i) => {
    const sl: StepLayout = { retryOffs: [], startOff: 0, endOff: 0, resultOffs: [] };
    if (step.afterNotification && i > 0) {
      cursor += ex.notifDelayMs;
      sl.notifOff = cursor;
      cursor += 50;
    } else if (step.afterNotification) {
      sl.notifOff = 0;
    }
    if (ex.compaction && ex.compaction.atStep === i) {
      sl.compactOff = cursor;
      cursor += ex.compactMs;
    }
    if (step.metaContinue) {
      sl.metaOff = cursor;
      cursor += 20;
    }
    for (const r of step.retries) {
      sl.retryOffs.push(cursor);
      cursor += r.retryInMs;
    }
    sl.startOff = cursor;
    if (step.failed) {
      sl.endOff = cursor;
      steps.push(sl);
      return;
    }
    sl.endOff = sl.startOff + step.latencyMs;
    cursor = sl.endOff;
    let prev = cursor;
    for (const call of step.calls) {
      prev = Math.max(prev, sl.endOff + call.execMs);
      sl.resultOffs.push(prev);
    }
    cursor = prev;
    ex.queued.forEach((q, qi) => {
      if (q.afterStep !== i) return;
      queued[qi] = {
        // Typed while the agent works on this step's tools; delivered right after their results.
        enqOff: sl.endOff,
        deliverOff: cursor + 1,
      };
      cursor += 1;
    });
    steps.push(sl);
  });

  let interruptOff: number | undefined;
  if (ex.interrupt) {
    interruptOff = cursor + ex.interruptDelayMs;
    cursor = interruptOff;
  }
  const out: Layout = { steps, queued, endOff: cursor + ex.tailMs };
  if (interruptOff !== undefined) out.interruptOff = interruptOff;
  return out;
}
