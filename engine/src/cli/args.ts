/** A tiny option parser: `--flag`, `--key value`, `--key=value`, positionals, `--` to end options. Zero dependencies. */

export class UsageError extends Error {}

export interface ArgSpec {
  /** Flags that take no value. */
  bool?: readonly string[];
  /** Flags that take one value. */
  value?: readonly string[];
  /** Positional arguments allowed (default 0). */
  positionals?: number;
}

export interface Parsed {
  flags: Map<string, string | true>;
  pos: string[];
}

/** `--json` is added to every command by the app's engine runner, so every command accepts it. */
export function parseArgs(argv: readonly string[], spec: ArgSpec): Parsed {
  const bool = new Set([...(spec.bool ?? []), "json"]);
  const value = new Set(spec.value ?? []);
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (rest || !a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    if (a === "--") {
      rest = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (bool.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (value.has(name)) {
      let v: string | undefined;
      if (eq >= 0) v = a.slice(eq + 1);
      else {
        v = argv[++i];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      }
      flags.set(name, v);
    } else {
      throw new UsageError(`unknown option --${name.slice(0, 24).replace(/[^A-Za-z0-9-]/g, "?")}`);
    }
  }
  if (pos.length > (spec.positionals ?? 0)) {
    // Named only when it is a plain word: an argument can be a path, and errors never print paths.
    const extra = pos[spec.positionals ?? 0]!;
    throw new UsageError(/^[A-Za-z0-9._-]{1,24}$/.test(extra) ? `unexpected argument "${extra}"` : "unexpected argument");
  }
  return { flags, pos };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function has(p: Parsed, name: string): boolean {
  return p.flags.has(name);
}
