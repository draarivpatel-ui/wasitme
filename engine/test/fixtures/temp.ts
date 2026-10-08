/**
 * Temporary folders for synthetic fixtures, removed when the test process exits (node:test runs each test file in its
 * own process). Without this, one run of the reader tests left about 180 folders in the system temp folder, and a full
 * `npm test` about 560.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
let hooked = false;

/** A new empty folder under the system temp folder, named `<prefix>XXXXXX`, deleted at process exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of made) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best effort: a test may have left a folder unreadable on purpose */
        }
      }
    });
  }
  return dir;
}
