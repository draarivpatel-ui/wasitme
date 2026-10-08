/**
 * Everything a command needs from the outside world, passed in rather than read from globals: the environment, the two
 * output streams, whether stdout is a terminal and how wide, the platform and the clock. `realContext()` is the process;
 * tests build their own. (The scan itself still reads `process.env` for the home folder and the agent roots, so
 * in-process callers that need a different home set it there; the colour, width and platform choices come from here.)
 */
import { chooseMode, type ColorMode } from "./design-tokens.js";

export interface Sink {
  write(chunk: string): unknown;
}

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  stdout: Sink;
  stderr: Sink;
  stdoutIsTTY: boolean;
  /** Terminal width in columns when stdout is a terminal that reports one. */
  columns: number | undefined;
  platform: string;
  now: () => Date;
  /** Whether stdin is a terminal a question can be asked on (`history clear` asks before deleting). */
  stdinIsTTY?: boolean;
  /** Ask one question on the terminal and return the answer line (absent: nothing can be asked). */
  ask?: (question: string) => Promise<string>;
}

export function realContext(): CliContext {
  // A closed pipe (`wasitme | head`) must end quietly, not crash with an unhandled 'error' event.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY: process.stdout.isTTY === true,
    columns: process.stdout.isTTY === true ? process.stdout.columns : undefined,
    platform: process.platform,
    now: () => new Date(),
    stdinIsTTY: process.stdin.isTTY === true,
    ask: async (question: string): Promise<string> => {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string>((resolve) => {
          rl.once("close", () => resolve(""));
          rl.question(question, resolve);
        });
      } finally {
        rl.close();
      }
    },
  };
}

/** The design system's colour mode for this context: NO_COLOR, a pipe or TERM=dumb print no escape codes at all. */
export function colorMode(ctx: CliContext): ColorMode {
  return chooseMode(ctx.env, ctx.stdoutIsTTY);
}

/** ASCII-only output for TERM=linux consoles and WASITME_ASCII=1 (design tokens: terminal.glyphFallback). */
export function asciiOnly(ctx: CliContext): boolean {
  return ctx.env.WASITME_ASCII === "1" || ctx.env.TERM === "linux";
}
