#!/usr/bin/env node
/**
 * Synthetic log generator CLI.
 *
 *   node engine/dist/src/synth/cli.js --scenario <name> --out <dir> [--seed N] [--days N] [--scale X] [--replace]
 *   node engine/dist/src/synth/cli.js --list
 *   node engine/dist/src/synth/cli.js --scenario <name> --digest        (print the determinism fingerprint, write nothing)
 *
 * Output layout:  <out>/claude  (use as CLAUDE_CONFIG_DIR)   <out>/codex  (use as CODEX_HOME)
 *                 <out>/synth-truth.json, <out>/synth-truth-exchanges.jsonl   (what was planted)
 * Everything is 100% synthetic and a pure function of (scenario, seed).
 */
import { writeFileSync } from "node:fs";
import { generate } from "./generate.js";
import { goldenTable } from "./golden.js";
import { generateHostile, type HostileTier } from "./hostile.js";
import { NAMED_SCENARIOS, SCENARIOS, findScenario } from "./scenarios.js";
import { digestFiles, writeTree } from "./write.js";

interface Args {
  scenario?: string;
  out?: string;
  seed?: number;
  days?: number;
  scale?: number;
  replace: boolean;
  digest: boolean;
  golden?: string;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { replace: false, digest: false, list: false, help: false };
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`${flag} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    const next = argv[i + 1];
    switch (f) {
      case "--scenario": a.scenario = next; i++; break;
      case "--out": a.out = next; i++; break;
      case "--seed": a.seed = num(f, next); i++; break;
      case "--days": a.days = num(f, next); i++; break;
      case "--scale": a.scale = num(f, next); i++; break;
      case "--replace": a.replace = true; break;
      case "--digest": a.digest = true; break;
      case "--golden": a.golden = next; i++; break;
      case "--list": a.list = true; break;
      case "--help": case "-h": a.help = true; break;
      default: throw new Error(`unknown argument ${f}`);
    }
  }
  return a;
}

const HELP = `wasitme synthetic log generator (synthetic data only; never reads real logs)

  --scenario <name>   one of: ${NAMED_SCENARIOS.join(", ")}, tiny-both, hostile, hostile-full
  --out <dir>         new or empty directory (or one this tool created, with --replace)
  --seed <N>          override the scenario's default seed
  --days <N>          override the run length (event days rescale)
  --scale <X>         multiply daily volume
  --replace           regenerate into a directory this tool created earlier
  --digest            print the determinism fingerprint instead of writing files
  --golden <file>     write the golden fingerprint table (all scenarios + hostile) to <file>
  --list              list scenarios
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.golden) {
    writeFileSync(args.golden, JSON.stringify(goldenTable(), null, 2) + "\n");
    process.stdout.write(`wrote ${args.golden}\n`);
    return;
  }
  if (args.list) {
    for (const s of SCENARIOS) process.stdout.write(`${s.name.padEnd(26)} seed ${s.defaultSeed}  ${s.defaultDays}d  ${s.description}\n`);
    process.stdout.write(`${"hostile".padEnd(26)} secrets, ANSI, bidi, HTML, malformed lines, deep nesting (small tier, committed under testdata/hostile)\n`);
    process.stdout.write(`${"hostile-full".padEnd(26)} hostile + 25 MB line, symlink loop, symlink outside the tree (not committable)\n`);
    return;
  }
  if (!args.scenario) throw new Error("--scenario is required (try --list)");
  if (!args.digest && !args.out) throw new Error("--out is required");

  if (args.scenario === "hostile" || args.scenario === "hostile-full") {
    const tier: HostileTier = args.scenario === "hostile-full" ? "full" : "small";
    const h = generateHostile(tier, args.seed);
    if (args.digest) { process.stdout.write(JSON.stringify(digestFiles(h.files, h.links)) + "\n"); return; }
    writeTree(args.out!, h.files, h.links, { replace: args.replace });
    process.stdout.write(`wrote ${h.files.length} files (${args.scenario}) to ${args.out}\n`);
    return;
  }

  const sc = findScenario(args.scenario);
  if (!sc) throw new Error(`unknown scenario "${args.scenario}" (try --list)`);
  const params = sc.build({ seed: args.seed, days: args.days, scale: args.scale });
  const g = generate(params, sc.name);
  if (args.digest) { process.stdout.write(JSON.stringify(digestFiles(g.files)) + "\n"); return; }
  writeTree(args.out!, g.files, [], { replace: args.replace });
  const ex = g.rows.length;
  process.stdout.write(`wrote ${g.files.length} files, ${ex} exchanges (${sc.name}, seed ${params.seed}) to ${args.out}\n`);
  process.stdout.write(`  CLAUDE_CONFIG_DIR=${args.out}/claude  CODEX_HOME=${args.out}/codex\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`synth: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
