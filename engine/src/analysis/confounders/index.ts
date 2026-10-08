/**
 * Confounders layer (WP-20b, METHOD.md §7–§8): directly standardised ratios, the projects rules, fragility (leave one
 * session out; the 3 most influential days), the research/08 df floor, the Holm-gated single-metric note and the
 * informational workload-mix flags. Pure, no I/O.
 */
export * from "./agreement.js";
export * from "./strata.js";
export * from "./standardise.js";
export * from "./projects.js";
export * from "./fragility.js";
export * from "./single.js";
export * from "./mix.js";
export * from "./assess.js";
