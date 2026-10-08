import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeHash } from "../../src/util.js";
import type { CollectOptions } from "../../src/extract/configsnap/index.js";

export const hash = makeHash("test-salt");
export const NOW = new Date("2026-10-04T12:00:00Z");

/** A throwaway home directory. Tests never read the real home, env, ~/.claude or ~/.codex. */
export class Fixture {
  readonly home: string;
  constructor() {
    this.home = mkdtempSync(join(tmpdir(), "wasitme-cs-"));
  }
  path(...parts: string[]): string {
    return join(this.home, ...parts);
  }
  mkdir(rel: string): string {
    const p = this.path(rel);
    mkdirSync(p, { recursive: true });
    return p;
  }
  write(rel: string, content: string | Buffer): string {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  }
  json(rel: string, value: unknown): string {
    return this.write(rel, JSON.stringify(value));
  }
  link(rel: string, target: string): string {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(target, p);
    return p;
  }
  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}

export function opts(fx: Fixture, extra: Partial<CollectOptions> = {}): CollectOptions {
  return { hash, now: NOW, home: fx.home, env: {}, avoid: [], ...extra };
}

/** Distinct sentinel strings planted in hostile fields; none may ever surface in any output. */
export const SENTINELS = [
  "SENTINEL_ENV_SECRET_9f3a",
  "SENTINEL_ARG_TOKEN_77c1",
  "SENTINEL_HOOK_CMD_41de",
  "SENTINEL_RULE_TEXT_a0b2",
  "SENTINEL_PLUGIN_NAME_5e5e",
  "SENTINEL_SERVER_NAME_c3c3",
  "SENTINEL_SKILL_NAME_d4d4",
  "SENTINEL_BODY_TEXT_e5e5",
  "/Users/sentinel-path",
  // Letters and digits only on purpose: these pass cleanLabel, so only a vocabulary check or hashing keeps them out.
  "SentinelProfileAcme41",
  "SentinelHookEvent52",
  "SentinelPermMode63",
  "SentinelApproval74",
  "SentinelSandbox85",
  "SentinelProvider96",
] as const;
