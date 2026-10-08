/**
 * WP-22 words: every engine-owned string of glance.v1 / snapshot.v1, for both lead variants (D28), and the bridge
 * that assembles the two contract documents from attribution results (no file I/O).
 *
 *   explain(attribution, opts)   → AgentWords (+ facts)                             one agent's words
 *   buildOutputs(input)          → { glance, snapshot, words, facts, problems }      what WP-12 writes, WP-30 renders
 *   lintAgentWords / lintStatusLine / lintGlanceWords                                the copy lints, on real output
 */
export * from "./tokens.js";
export * from "./format.js";
export * from "./names.js";
export * from "./recheck.js";
export * from "./facts.js";
export * from "./trace.js";
export * from "./words.js";
export * from "./lint.js";
export * from "./build.js";
