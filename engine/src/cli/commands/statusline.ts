/**
 * `wasitme statusline [install|uninstall|show]`: the Claude Code status line (README "Where you see it").
 *
 *   wasitme statusline                       the state line, like `wasitme status`
 *   wasitme statusline install   [--wrap] [--script ABS_PATH] [--claude-dir ABS_PATH]
 *   wasitme statusline uninstall [--script ABS_PATH] [--claude-dir ABS_PATH]
 *   wasitme statusline show      whose status line is configured: none | wasitme | other
 *
 * `install` edits one key of Claude Code's `settings.json` (see statusline/settings.ts). An existing status line that is
 * not wasitme's is left alone unless `--wrap` is given; then it is kept, backed up and wrapped. `uninstall` puts the old
 * text back byte for byte, only if the current one is still wasitme's.
 * The script defaults to the shim the installer writes (`~/.local/bin/wasitme-statusline`); the Claude folder is
 * `--claude-dir`, else CLAUDE_CONFIG_DIR, else `~/.claude`. Nothing else is touched.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { homePaths, wasitmeHome } from "../../store/home.js";
import { installStatusLine, statusLineFiles, statusLineState, StatusLineError, uninstallStatusLine } from "../../statusline/settings.js";
import { has, parseArgs, str, UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { CommandFailure, emit } from "./common.js";
import { status } from "./status.js";

const FAILURE_TEXT: Readonly<Record<StatusLineError["kind"], string>> = {
  script_missing: "the status-line script was not found or is not executable. wasitme's installer puts it in ~/.local/bin; run the installer, or pass --script with the script's absolute path",
  settings_unreadable: "Claude Code's settings file is not JSON that wasitme can edit safely; nothing was changed",
  settings_not_object: "Claude Code's settings file does not hold an object; nothing was changed",
  claude_folder_missing: "Claude Code's settings folder does not exist; run Claude Code once, or pass --claude-dir",
  edit_failed: "the edit could not be verified; nothing was changed",
};

function absolute(flag: string | undefined, fallback: string, what: string): string {
  const v = flag ?? fallback;
  if (!isAbsolute(v)) throw new UsageError(`${what} must be an absolute path`);
  return v;
}

export function statusline(ctx: CliContext, argv: readonly string[]): number {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub.startsWith("--")) return status(ctx, argv);
  if (sub !== "install" && sub !== "uninstall" && sub !== "show") throw new UsageError("usage: wasitme statusline [install|uninstall|show]");
  const p = parseArgs(rest, { bool: sub === "install" ? ["wrap"] : [], value: ["script", "claude-dir"] });
  const home = ctx.env.HOME !== undefined && isAbsolute(ctx.env.HOME) ? ctx.env.HOME : homedir();
  const claudeDir = absolute(str(p, "claude-dir"), ctx.env.CLAUDE_CONFIG_DIR !== undefined && ctx.env.CLAUDE_CONFIG_DIR !== "" ? ctx.env.CLAUDE_CONFIG_DIR : join(home, ".claude"), "--claude-dir");
  const script = absolute(str(p, "script"), join(home, ".local", "bin", "wasitme-statusline"), "--script");
  const files = statusLineFiles(claudeDir, homePaths(wasitmeHome(ctx.env)).home);
  try {
    if (sub === "show") {
      const s = statusLineState(files, script);
      const word = s === "ours" ? "wasitme" : s;
      emit(ctx, `Status line: ${word === "unreadable" ? "settings file not readable" : word}\n`);
      return 0;
    }
    if (sub === "install") {
      // Yours is never changed unless you ask (README; the installer refuses the same way): without --wrap, an existing
      // status line that is not wasitme's is left exactly as it is.
      if (!has(p, "wrap") && statusLineState(files, script) === "other") {
        throw new CommandFailure("you already have a Claude Code status line, so wasitme left it alone. To show wasitme's next to yours, run: wasitme statusline install --wrap");
      }
      const r = installStatusLine(files, script);
      emit(ctx, r.changed ? `Status line: installed.${r.wrapped ? " Your previous status line is kept and wrapped." : ""}\n` : "Status line: already installed.\n");
      return 0;
    }
    const r = uninstallStatusLine(files, script);
    const text = r.why === "restored" ? "restored to what it was before wasitme."
      : r.why === "removed" ? "removed."
      : r.why === "not_ours" ? "left alone (it is not wasitme's any more)."
      : "wasitme's was not installed.";
    emit(ctx, `Status line: ${text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof StatusLineError) throw new CommandFailure(FAILURE_TEXT[e.kind]);
    throw e;
  }
}
