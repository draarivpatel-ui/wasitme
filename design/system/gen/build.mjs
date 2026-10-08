// Regenerates everything derived from tokens.json. Usage: node design/system/gen/build.mjs [--check]
// --check writes nothing and exits 1 if any generated file is stale (used by test.mjs and CI).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadTokens } from './lib.mjs';
import { css } from './gen-css.mjs';
import { swift } from './gen-swift.mjs';
import { ts } from './gen-ts.mjs';
import { report } from './gen-report.mjs';

export function outputs(t = loadTokens()) {
  return {
    'generated/tokens.css': css(t),
    'generated/tokens.inline.css': css(t, { embed: true }),
    'generated/Tokens.swift': swift(t),
    'generated/tokens.ts': ts(t),
    'generated/contrast-report.md': report(t),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, body] of Object.entries(outputs())) {
    const p = join(ROOT, rel);
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : null;
    if (cur === body) continue;
    if (check) { console.error(`stale: ${rel}`); stale++; }
    else { writeFileSync(p, body); console.log(`wrote ${rel}`); }
  }
  if (check && stale) process.exit(1);
}
