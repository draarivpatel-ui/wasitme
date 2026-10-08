/** Number, date and ratio formatting. Locale-independent (the same digits in WebKit, Chrome and Node). */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day "YYYY-MM-DD" that really exists, else null. */
export function validDay(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = DAY_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? s : null;
}

/** Days since 1970-01-01 (UTC calendar arithmetic; days are local calendar days, never instants). */
export function dayNum(day: string): number {
  const m = DAY_RE.exec(day)!;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

export function dayStr(n: number): string {
  const d = new Date(n * 86400000);
  const p = (x: number) => (x < 10 ? "0" : "") + x;
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function addDays(day: string, n: number): string { return dayStr(dayNum(day) + n); }

/** "2026-09-21" → "Sep 21". */
export function fdate(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  return `${MON[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** "Sep 20 – Oct 3". */
export function frange(from: string, to: string): string { return `${fdate(from)} – ${fdate(to)}`; }

/** 1195 → "1,195". Integers only (counts). */
export function num(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return (n < 0 ? "-" : "") + out;
}

/** Ratio with two decimals: 0.75 → "×0.75". */
export function x2(r: number): string { return "×" + r.toFixed(2); }

/** A short multiplier without trailing zeros: 2 → "×2", 2.5 → "×2.5", 1.15 → "×1.15". */
export function xs(r: number): string {
  let s = r.toFixed(2);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return "×" + s;
}

/** Compact durations: "4 min", "3 h", "2 days" (the app's AppCopy.duration). */
export function duration(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} days`;
}

/** "Oct 4, 18:00" in the given IANA zone (default: the system zone). */
export function stamp(ms: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** The calendar day of an instant in the given zone, "YYYY-MM-DD". */
export function dayOf(ms: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function plural(n: number, one: string, many: string): string { return `${num(n)} ${n === 1 ? one : many}`; }

/** UI-owned display copy uses the typographic apostrophe (as in the design screens); engine text stays verbatim. */
export function typographic(s: string): string { return s.replace(/'/g, "’"); }

/** Fills a copy template's `{name}` placeholders (tokens.json copy.canvas). A placeholder with no value is left as it
 *  is, so a missing value is visible (and caught by the model tests) instead of silently dropped. */
export function fill(tpl: string, vars: { [name: string]: string | number }): string {
  return tpl.replace(/\{([A-Za-z]+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** Sentence case for a lower-case UI phrase ("edits" → "Edits"). */
export function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
