/** Small shared helpers for the renderers and the on-disk writer. */

export interface OutFile {
  /** Path relative to the output root, "/"-separated. */
  path: string;
  data: string | Buffer;
  /** Deterministic mtime to stamp on the file (ms since epoch). */
  mtimeMs?: number;
}

/** Always "YYYY-MM-DDTHH:MM:SS.mmmZ". */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function jsonLine(o: unknown): string {
  return JSON.stringify(o);
}

export function joinLines(lines: string[]): string {
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** "2026-07-01T14-03-11" as used in Codex rollout file names (UTC). */
export function rolloutStamp(ms: number): string {
  return iso(ms).slice(0, 19).replace(/:/g, "-");
}
