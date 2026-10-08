/**
 * Where the report commands get their document (`wasitme`, `wasitme report`): the results file the scan wrote
 * (`snapshot.json`), refreshed by a scan on demand when there is none or it is out of date. Linux has no background
 * scan (README "Install", platform table), and on macOS a user can run `wasitme` before the first LaunchAgent run, so the CLI
 * scans when it needs to, exactly as `wasitme scan` does (same lock, same atomic writes, incremental and idempotent).
 *
 *   --no-scan     never scan; show the file as it is (stale results say so)
 *   --read-only   analyse in memory and write nothing anywhere (the plugin's skill uses it)
 *   --until T     a time-travelled analysis; always read-only, so it can never replace the live results
 *
 * A scan that is already running is waited for (up to `waitMs`), not raced; if it does not finish, whatever file there
 * is gets shown, marked as it is. Only error KINDS are carried out of here, never messages (they can embed paths).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { homePaths, wasitmeHome } from "../store/home.js";
import { readOwnFile } from "../store/atomic.js";
import { errorKind, runScan } from "../store/scan.js";
import type { ScanError } from "../contract/vocab.js";
import { coerceDoc, emptyDoc, type ReportDoc } from "../output/doc.js";
import type { CliContext } from "./context.js";

export interface AcquireOptions {
  noScan: boolean;
  readOnly: boolean;
  until?: Date;
  timeZone: string;
  /** How long to wait for another scan to finish. */
  waitMs: number;
}

export interface Acquired {
  doc: ReportDoc;
  /** The parsed JSON the document was made from (for `--json` passthrough). */
  raw: unknown;
  /** A scan ran for this call. */
  scanned: boolean;
  /** Another scan was still running when we gave up waiting. */
  stillBusy: boolean;
  /** The scan this call started failed (the document is the last good file, if any). */
  scanFailed: ScanError | null;
}

/** The results file, parsed; or why there is none ("missing": no file yet; "damaged": there, but not readable JSON). */
function readSnapshotFile(ctx: CliContext): { raw: unknown; doc: ReportDoc } | "missing" | "damaged" {
  const p = homePaths(wasitmeHome(ctx.env));
  const r = readOwnFile(p.snapshot, 8 << 20);
  if (!r.buf) return r.why === "missing" ? "missing" : "damaged";
  try {
    const raw = JSON.parse(r.buf.toString("utf8")) as unknown;
    return { raw, doc: coerceDoc(raw, ctx.now().getTime()) };
  } catch {
    return "damaged";
  }
}

const nothing = (why: "missing" | "damaged", stillBusy: boolean): Acquired =>
  ({ doc: emptyDoc("empty", why), raw: null, scanned: false, stillBusy, scanFailed: null });

export async function acquire(ctx: CliContext, o: AcquireOptions): Promise<Acquired> {
  const now = ctx.now();
  if (o.readOnly || o.until !== undefined) {
    const r = await runScan({ readOnly: true, noProjectFiles: true, timeZone: o.timeZone, now, ...(o.until !== undefined ? { until: o.until } : {}) });
    return { doc: coerceDoc(r.snapshot, now.getTime()), raw: r.snapshot, scanned: true, stillBusy: false, scanFailed: null };
  }
  const read = readSnapshotFile(ctx);
  const have = typeof read === "object" ? read : null;
  const usable = have !== null && (have.doc.display === "ok" || have.doc.display === "empty");
  if (o.noScan || usable) {
    if (have !== null) return { doc: have.doc, raw: have.raw, scanned: false, stillBusy: false, scanFailed: null };
    if (o.noScan && typeof read === "string") return nothing(read, false);
  }
  const deadline = Date.now() + o.waitMs;
  try {
    for (;;) {
      const r = await runScan({ timeZone: o.timeZone, noProjectFiles: true, now: ctx.now() });
      if (!r.busy) return { doc: coerceDoc(r.snapshot, ctx.now().getTime()), raw: r.snapshot, scanned: true, stillBusy: false, scanFailed: null };
      if (Date.now() >= deadline) break;
      await sleep(300);
    }
  } catch (e) {
    const kind = errorKind(e);
    if (have !== null) return { doc: have.doc, raw: have.raw, scanned: false, stillBusy: false, scanFailed: kind };
    throw e;
  }
  // Still busy: show what there is.
  if (have !== null) return { doc: have.doc, raw: have.raw, scanned: false, stillBusy: true, scanFailed: null };
  const again = readSnapshotFile(ctx);
  if (typeof again === "object") return { doc: again.doc, raw: again.raw, scanned: false, stillBusy: true, scanFailed: null };
  return nothing(again, true);
}
