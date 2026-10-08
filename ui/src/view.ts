/**
 * The Settings facts the Mac app sends in `view` (docs/design/UX-V2.md §10.2). This is the app's own message to its
 * own page, not the shared contract. It is read like the snapshot: own properties only, closed vocabularies only, and
 * anything else counts as unknown. `view` carries codes, never sentences: every word the Settings page shows is the
 * canvas's own (tokens.json copy.canvas.settings).
 *
 *   view.launchAtLogin   "on" | "off" | "needsApproval" | "viaInstaller" | "unavailable" (LaunchAtLoginState, sent today)
 *   view.settings        { version, installed, answered, integrations: [{id, state, why?}], desktopPanel,
 *                          launchAtLogin, update, canClearHistory, busy }
 *                        (macos SettingsState.viewObject: `install.sh --status --json` plus the app's own state).
 *                        Native sends it only once it handles every Settings action (§10.1); without it `wired` is
 *                        false and the page draws those controls disabled with "Not available in this version." (§9.4
 *                        shipping rule). `answered: false` (the installer has not answered yet, or could not be asked)
 *                        and `installed: false` disable every control the installer runs; `canClearHistory: false`
 *                        disables Clear History. A missing flag is read as true, so only an explicit no disables.
 */

import { isObj } from "./decode.js";

export type PartId = "app" | "claude-plugin" | "statusline" | "codex-plugin" | "scan";
export type PartState = "on" | "off" | "own" | "unavailable" | "unknown";
export type LaunchState = "on" | "off" | "needsApproval" | "viaInstaller" | "unavailable";
export type WhyCode = "agent_missing" | "no_install_record" | "no_release" | "not_supported";

export interface SettingsView {
  /** native sent `settings`: it performs every Settings action, so the page may offer them. */
  wired: boolean;
  /** The installer answered `--status` (false: still reading, or it could not be asked). */
  answered: boolean;
  /** An install record exists (false: nothing for the installer or uninstaller to act on). */
  installed: boolean;
  /** The engine is set up, so there is a saved history Clear History can delete. */
  canClearHistory: boolean;
  version: string | null;
  parts: { [id: string]: { state: PartState; why: WhyCode | null } };
  desktopPanel: boolean | null;
  launchAtLogin: LaunchState | null;
  update: { available: boolean; why: WhyCode | null } | null;
  /** The part id or action name running now. */
  busy: string | null;
}

/** The install parts in the order the Settings page lists them (`install.sh --status` ids). */
export const PART_IDS: readonly PartId[] = ["app", "claude-plugin", "statusline", "codex-plugin", "scan"];
const STATES: readonly PartState[] = ["on", "off", "own", "unavailable", "unknown"];
const LAUNCH: readonly LaunchState[] = ["on", "off", "needsApproval", "viaInstaller", "unavailable"];
const WHY: readonly WhyCode[] = ["agent_missing", "no_install_record", "no_release", "not_supported"];


const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const member = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export const NO_SETTINGS: SettingsView = {
  wired: false, answered: false, installed: false, canClearHistory: false, version: null, parts: {}, desktopPanel: null, launchAtLogin: null, update: null, busy: null,
};

export function decodeSettings(view: unknown): SettingsView {
  const s = own(view, "settings");
  const top = own(view, "launchAtLogin");
  const fromTop = member(LAUNCH, top) ? top : null;
  const flag = own(s, "launchAtLogin");
  const fromSettings: LaunchState | null = flag === true ? "on" : flag === false ? "off" : null;
  const launchAtLogin = fromTop && fromTop !== "unavailable" ? fromTop : fromSettings ?? fromTop;
  if (!isObj(s)) return { ...NO_SETTINGS, launchAtLogin };
  const parts: SettingsView["parts"] = {};
  const list = own(s, "integrations");
  if (Array.isArray(list)) {
    for (const x of list.slice(0, 16)) {
      const raw = own(x, "id");
      const id = raw === "scan-agent" ? "scan" : raw;
      if (!member(PART_IDS, id) || Object.hasOwn(parts, id)) continue;
      const st = own(x, "state"), why = own(x, "why");
      parts[id] = { state: member(STATES, st) ? st : "unknown", why: member(WHY, why) ? why : null };
    }
  }
  const v = own(s, "version");
  const dp = own(s, "desktopPanel");
  const up = own(s, "update");
  const avail = own(up, "available"), upWhy = own(up, "why");
  const busy = own(s, "busy");
  return {
    wired: true,
    answered: own(s, "answered") !== false,
    installed: own(s, "installed") !== false,
    canClearHistory: own(s, "canClearHistory") !== false,
    version: typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : null,
    parts,
    desktopPanel: typeof dp === "boolean" ? dp : null,
    launchAtLogin,
    update: isObj(up) && typeof avail === "boolean" ? { available: avail, why: member(WHY, upWhy) ? upWhy : null } : null,
    busy: typeof busy === "string" && /^[A-Za-z-]{1,32}$/.test(busy) ? (busy === "scan-agent" ? "scan" : busy) : null,
  };
}
