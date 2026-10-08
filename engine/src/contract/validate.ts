/**
 * A tiny JSON Schema (2020-12 subset) validator for the two contract schemas. Zero dependencies.
 *
 * It supports exactly the keywords the contract uses and REFUSES a schema that uses any other keyword, so a test
 * can never pass because the validator silently ignored a rule. Strings are measured in code points (as JSON
 * Schema specifies), `$ref` is local only (`#/$defs/<name>`), and `format` is asserted for `date-time`
 * (RFC 3339 with an explicit offset) and `date` (a real calendar day).
 */

export type JsonSchema = { [keyword: string]: unknown } | boolean;

export interface SchemaError { path: string; message: string }

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs"]);
const ASSERTIONS = new Set([
  "type", "const", "enum", "required", "properties", "additionalProperties", "items", "minItems", "maxItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "$ref", "oneOf", "format", "maxProperties", "propertyNames",
]);
const FORMATS = new Set(["date-time", "date"]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

type Obj = { [key: string]: unknown };

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Throws if the schema uses a keyword, type, format or $ref this validator does not implement. */
export function assertSupportedSchema(root: JsonSchema): void {
  const defs = isObj(root) && isObj(root.$defs) ? root.$defs : {};
  const visit = (s: unknown, at: string): void => {
    if (typeof s === "boolean") return;
    if (!isObj(s)) throw new Error(`${at}: a schema must be an object or a boolean`);
    for (const key of Object.keys(s)) {
      if (!ANNOTATIONS.has(key) && !ASSERTIONS.has(key)) throw new Error(`${at}: unsupported keyword "${key}"`);
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      for (const t of types) if (typeof t !== "string" || !TYPES.has(t)) throw new Error(`${at}: unsupported type ${JSON.stringify(t)}`);
    }
    if (s.format !== undefined && (typeof s.format !== "string" || !FORMATS.has(s.format))) {
      throw new Error(`${at}: unsupported format ${JSON.stringify(s.format)}`);
    }
    if (s.pattern !== undefined) new RegExp(String(s.pattern), "u");
    if (s.$ref !== undefined) {
      const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(String(s.$ref));
      if (m === null || !Object.hasOwn(defs, m[1]!)) throw new Error(`${at}: unresolvable $ref ${JSON.stringify(s.$ref)}`);
    }
    if (isObj(s.properties)) for (const [k, v] of Object.entries(s.properties)) visit(v, `${at}.properties.${k}`);
    if (s.items !== undefined) visit(s.items, `${at}.items`);
    if (s.additionalProperties !== undefined) visit(s.additionalProperties, `${at}.additionalProperties`);
    if (s.propertyNames !== undefined) visit(s.propertyNames, `${at}.propertyNames`);
    if (Array.isArray(s.oneOf)) s.oneOf.forEach((v, i) => visit(v, `${at}.oneOf[${i}]`));
    if (isObj(s.$defs)) for (const [k, v] of Object.entries(s.$defs)) visit(v, `${at}.$defs.${k}`);
  };
  visit(root, "#");
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (typeof v === "number" && !Number.isFinite(v)) return false;
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a as Obj);
  const kb = Object.keys(b as Obj);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as Obj, k) && jsonEqual((a as Obj)[k], (b as Obj)[k]));
}

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function isDateTime(s: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(s);
  if (m === null || !isDate(m[1]!)) return false;
  const [h, mi, se] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const [oh, om] = [Number(m[5] ?? 0), Number(m[6] ?? 0)];
  return h <= 23 && mi <= 59 && se <= 60 && oh <= 23 && om <= 59;
}

/** Validates `value` against `root`. Returns every error found (empty = valid). */
export function validate(root: JsonSchema, value: unknown): SchemaError[] {
  assertSupportedSchema(root);
  const defs = (isObj(root) && isObj(root.$defs) ? root.$defs : {}) as Obj;
  const errors: SchemaError[] = [];

  const check = (s: JsonSchema, v: unknown, path: string, out: SchemaError[]): void => {
    if (s === true) return;
    if (s === false) { out.push({ path, message: "not allowed" }); return; }
    const fail = (message: string) => out.push({ path, message });

    if (typeof s.$ref === "string") check(defs[s.$ref.slice("#/$defs/".length)] as JsonSchema, v, path, out);
    if (Object.hasOwn(s, "const") && !jsonEqual(v, s.const)) fail(`expected ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => jsonEqual(e, v))) fail(`${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
      if (!types.some((t) => matchesType(v, t))) { fail(`expected ${types.join("|")}, got ${typeOf(v)}`); return; }
    }
    if (Array.isArray(s.oneOf)) {
      const passing = s.oneOf.filter((sub) => { const e: SchemaError[] = []; check(sub as JsonSchema, v, path, e); return e.length === 0; }).length;
      if (passing !== 1) {
        if (passing === 0) {
          // Report the errors of the branch whose type matches, if any: far more useful than "no branch".
          const typed = s.oneOf.find((sub) => isObj(sub) && (sub.type === undefined || [sub.type].flat().some((t) => matchesType(v, String(t)))));
          if (typed !== undefined) check(typed as JsonSchema, v, path, out);
          else fail("matches no oneOf branch");
        } else fail(`matches ${passing} oneOf branches (exactly one required)`);
      }
    }

    if (typeof v === "string") {
      const len = [...v].length;
      if (typeof s.minLength === "number" && len < s.minLength) fail(`shorter than ${s.minLength}`);
      if (typeof s.maxLength === "number" && len > s.maxLength) fail(`longer than ${s.maxLength} (${len})`);
      if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) fail(`does not match ${s.pattern}`);
      if (s.format === "date" && !isDate(v)) fail("not a date (YYYY-MM-DD)");
      if (s.format === "date-time" && !isDateTime(v)) fail("not an RFC 3339 date-time with an offset");
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) fail(`below ${s.minimum}`);
      if (typeof s.maximum === "number" && v > s.maximum) fail(`above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) fail(`fewer than ${s.minItems} items`);
      if (typeof s.maxItems === "number" && v.length > s.maxItems) fail(`more than ${s.maxItems} items`);
      if (s.items !== undefined) v.forEach((item, i) => check(s.items as JsonSchema, item, `${path}[${i}]`, out));
    }
    if (isObj(v)) {
      const keys = Object.keys(v);
      if (Array.isArray(s.required)) for (const k of s.required) if (!Object.hasOwn(v, String(k))) fail(`missing "${String(k)}"`);
      if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) fail(`more than ${s.maxProperties} properties`);
      const props = isObj(s.properties) ? s.properties : {};
      for (const k of keys) {
        const at = `${path}.${k}`;
        if (s.propertyNames !== undefined) check(s.propertyNames as JsonSchema, k, `${at} (name)`, out);
        if (Object.hasOwn(props, k)) check(props[k] as JsonSchema, v[k], at, out);
        else if (s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) out.push({ path: at, message: "unexpected property" });
          else check(s.additionalProperties as JsonSchema, v[k], at, out);
        }
      }
    }
  };

  check(root, value, "$", errors);
  return errors;
}
