/**
 * glance.json / snapshot.json serialisation (contract glance.v1 / snapshot.v1, frozen; docs/CONTRACT.md).
 *
 * The documents themselves are built by the words layer (engine/src/words/build.ts `buildOutputs`, WP-22) from each
 * agent's attribution (WP-21); scan.ts writes what it returns, and nothing when it reports problems (D59). WP-12's
 * interim builder (every agent `insufficient (calibration_pending)` with hand-written words) is gone.
 */
import type { Glance } from "../contract/glance.js";
import type { Snapshot } from "../contract/snapshot.js";

/** Serialise as the engine writes: compact JSON plus a newline. */
export function serializeOutput(doc: Glance | Snapshot): string {
  return `${JSON.stringify(doc)}\n`;
}
