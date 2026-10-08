/**
 * Scan failures as KINDS (never messages: they can embed paths). Kept out of scan.ts so the CLI entry point can name a
 * failure without loading the scan, the readers and the analysis (`wasitme status` loads only what it needs).
 */
import type { ScanError } from "../contract/vocab.js";
import { HomeError } from "./home.js";

export class ScanFailure extends Error {
  /** For `internal` output failures: the problems `buildOutputs` reported (in memory only; the CLI prints the kind). */
  readonly problems: readonly string[];
  constructor(readonly kind: ScanError, message: string, problems: readonly string[] = []) {
    super(message);
    this.problems = problems;
  }
}

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

export function errorKind(e: unknown): ScanError {
  if (e instanceof ScanFailure) return e.kind;
  if (e instanceof HomeError) return e.kind;
  const c = code(e);
  if (c === "EACCES" || c === "EPERM" || c === "ERR_ACCESS_DENIED") return "permission_denied";
  if (c === "ENOSPC" || c === "EROFS" || c === "EDQUOT" || c === "EIO" || c === "EISDIR" || c === "ENOTDIR") return "write_failed";
  return "internal";
}
