/**
 * `wasitme history clear [--yes]`: delete the saved history and results without uninstalling (store/clear.ts has the
 * exact list). Settings, exclusions, the salt and the install stay, so the next scan starts fresh from the logs the
 * agents still keep.
 *
 * It asks first on a terminal (Enter = no). Without a terminal to ask on (the Mac app, a script) it needs `--yes` and
 * otherwise refuses with exit 2, deleting nothing. A scan that holds the lock is waited for briefly; if it is still
 * running, exit 1 and nothing is deleted. Output names counts only, never a path.
 *
 * Exit codes: 0 cleared (or nothing to clear), 1 failed or a scan was running (nothing deleted), 2 usage / no --yes.
 */
import { clearHistory, clearPreview } from "../../store/clear.js";
import { homePaths, wasitmeHome } from "../../store/home.js";
import { has, parseArgs, UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { CommandFailure, emit, emitJson } from "./common.js";

const KEPT = "Your settings, exclusions and the install were kept.";

function size(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function files(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

export async function history(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "clear") throw new UsageError("usage: wasitme history clear [--yes]");
  const a = parseArgs(rest, { bool: ["yes"] });
  const json = has(a, "json");
  const p = homePaths(wasitmeHome(ctx.env));

  if (!has(a, "yes")) {
    const ask = ctx.ask;
    if (json || ctx.stdinIsTTY !== true || !ctx.stdoutIsTTY || ask === undefined) {
      throw new CommandFailure("history clear deletes your saved wasitme history and there is no terminal to confirm on; add --yes to proceed. Nothing was deleted.", 2);
    }
    const preview = clearPreview(p);
    if (!preview.existed || preview.files === 0) {
      emit(ctx, "There is no saved history to delete.\n");
      return 0;
    }
    const answer = await ask(`Permanently delete your saved wasitme history and results (${files(preview.files)}, ${size(preview.bytes)})? ${KEPT.replace("were kept", "stay")} [y/N] `);
    if (!/^\s*y(es)?\s*$/i.test(answer)) {
      emit(ctx, "Nothing was deleted.\n");
      return 0;
    }
  }

  const r = await clearHistory(p);
  if (r.busy) throw new CommandFailure("a scan is running right now, so nothing was deleted. Try again in a minute.");
  if (json) {
    emitJson(ctx, { schema: "wasitme.history-clear/1", cleared: r.files > 0, files: r.files, bytes: r.bytes });
    return 0;
  }
  if (!r.existed || r.files === 0) {
    emit(ctx, "There was no saved history to delete.\n");
    return 0;
  }
  emit(ctx, `Deleted your saved wasitme history and results (${files(r.files)}, ${size(r.bytes)}). ${KEPT}\nThe next scan starts fresh from the logs your agents still keep: wasitme scan\n`);
  return 0;
}
