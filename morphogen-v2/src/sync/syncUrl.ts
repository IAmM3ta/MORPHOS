/**
 * Sync URL hygiene (2026-10-08, REBUILD-SPEC §6 client hardening; red-team
 * H-WS / M-PERSIST, static-findings #2 and #8).
 *
 * Three pure pieces, kept out of TdClient so they are unit-testable and so the
 * future path-picker UI can call them on every keystroke without a socket:
 *
 *   classifyTdHost()  — loopback | mdns (*.local) | remote. The spec allowlist is
 *                       127.0.0.1 / localhost / *.local; everything else is
 *                       "remote" and needs an explicit, per-session confirm.
 *   sanitizeTdUrl()   — one canonical ws:// / wss:// string or a reason. Rejects
 *                       credentials-in-URL, fragments, control chars, odd schemes
 *                       and oversized pastes; never echoes the input back.
 *   load/saveSyncSettings() — the persisted Sync record. Schema-validated on
 *                       rehydrate (unknown keys dropped, bad JSON wiped), URL
 *                       re-sanitised, auth token NEVER stored, and a remote host
 *                       always comes back with needsConfirm:true — a confirm is
 *                       not persisted, so tampered localStorage on a shared
 *                       machine cannot silently aim the next session at an
 *                       attacker's wss endpoint.
 */
import type { SyncPath } from './tdClient';

export type TdHostClass = 'loopback' | 'mdns' | 'remote';

/** Hard cap on a pasted URL; real TD endpoints are a few dozen chars. */
export const MAX_TD_URL_LEN = 512;
/** localStorage key for the persisted Sync record (v2 app; v1 used zustand `morphogen-v7`). */
export const SYNC_SETTINGS_KEY = 'morphogen-v2.sync';
export const SYNC_SETTINGS_VERSION = 1;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** One DNS label: letters/digits/hyphen, no leading/trailing hyphen, ≤63 chars. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Classify a URL hostname (as returned by `new URL(...).hostname`, so already
 * lower-cased and IDNA-encoded). `*.local` only counts as mDNS when every label
 * is a plain DNS label (`studio-pc.local`, `td.stage.local`); a bare `local`,
 * empty labels (`x..local`) or underscores fall through to remote. IPv6 other
 * than ::1 and private IPv4 ranges are deliberately remote too — the confirm
 * is cheap, and LAN IPs are exactly what tunnels and hotel Wi-Fi hand out.
 */
export function classifyTdHost(hostname: string): TdHostClass {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTS.has(h)) return 'loopback';
  if (h.endsWith('.local')) {
    const labels = h.split('.');
    if (labels.length >= 2 && labels.every((l) => DNS_LABEL.test(l))) return 'mdns';
  }
  return 'remote';
}

export type SanitizedTdUrl =
  | { ok: true; url: string; host: string; hostClass: TdHostClass; scheme: 'ws:' | 'wss:' }
  | { ok: false; reason: string };

/**
 * Normalise a user- or storage-supplied TD URL. Returns the canonical string
 * (lower-cased scheme/host, default path '/', no fragment) or a fixed reason.
 * Reasons never include the input, so a pasted secret can't end up in the UI
 * or logs via an error message.
 */
export function sanitizeTdUrl(raw: unknown): SanitizedTdUrl {
  if (typeof raw !== 'string') return { ok: false, reason: 'TD URL must be text' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'TD URL is empty' };
  if (s.length > MAX_TD_URL_LEN) return { ok: false, reason: `TD URL too long (max ${MAX_TD_URL_LEN} chars)` };
  // Control chars / whitespace inside the URL: URL() would silently strip some
  // of them, which is exactly how look-alike pastes get through.
  if (/[\u0000-\u0020\u007f]/.test(s)) return { ok: false, reason: 'TD URL contains spaces or control characters' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    return { ok: false, reason: 'TD URL must start with ws:// or wss://' };
  }
  if (u.username || u.password) {
    // Browsers ignore WS userinfo for auth anyway; it only leaks into storage/history.
    return { ok: false, reason: 'Do not put credentials in the TD URL — use the Sync secret field' };
  }
  if (!u.hostname) return { ok: false, reason: 'TD URL has no host' };
  u.hash = '';
  return {
    ok: true,
    url: u.toString(),
    host: u.hostname,
    hostClass: classifyTdHost(u.hostname),
    scheme: u.protocol,
  };
}

/** Remote (non-allowlisted) hosts need a per-session confirm before connect. */
export function tdUrlNeedsConfirm(s: SanitizedTdUrl): boolean {
  return s.ok && s.hostClass === 'remote';
}

/**
 * Spec: `tdGrid` (256 floats every pump) defaults OFF unless TD is on this
 * machine — cheap on loopback, painful on LAN Wi-Fi and tunnels (Elliot M2).
 */
export function defaultTdGrid(hostClass: TdHostClass): boolean {
  return hostClass === 'loopback';
}

/** Plain-text confirm prompt for a remote host; names the host, never the secret. */
export function remoteConfirmMessage(host: string): string {
  return (
    `Send live Sync telemetry (sensors, touches, mic level, field) to ${host}?\n` +
    'This host is not on the local allowlist (127.0.0.1, localhost, *.local). ' +
    'Only continue if you run this TouchDesigner server.'
  );
}

/* ------------------------------ persistence ------------------------------ */

export type SyncSettings = {
  url: string;
  path: SyncPath;
  grid: boolean;
};

export type LoadedSyncSettings = SyncSettings & {
  /** True when the saved host is remote: the UI must confirm again before connect(). */
  needsConfirm: boolean;
  /** Why the stored record was discarded (fresh defaults returned), if it was. */
  dropped: string | null;
};

/** Minimal Storage surface so tests (and non-browser hosts) can inject a fake. */
export type SyncStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const SYNC_PATHS: readonly SyncPath[] = ['companion', 'midi', 'wss'];

export const DEFAULT_SYNC_SETTINGS: SyncSettings = Object.freeze({
  url: 'ws://127.0.0.1:9980/',
  path: 'companion',
  grid: true,
}) as SyncSettings;

function defaults(dropped: string | null): LoadedSyncSettings {
  return { ...DEFAULT_SYNC_SETTINGS, needsConfirm: false, dropped };
}

/**
 * Rehydrate the Sync record. Anything unexpected — bad JSON, wrong version,
 * non-object, bad path, URL that fails sanitizeTdUrl — wipes the key and
 * returns defaults with `dropped` set. Only the three known fields are read
 * (no object spread, so `__proto__` / extra keys are inert). A stored `auth`
 * field is ignored and the key rewritten without it.
 */
export function loadSyncSettings(storage: SyncStorage | null | undefined): LoadedSyncSettings {
  if (!storage) return defaults(null);
  let raw: string | null;
  try {
    raw = storage.getItem(SYNC_SETTINGS_KEY);
  } catch {
    return defaults('storage unavailable');
  }
  if (raw === null) return defaults(null);
  const wipe = (why: string): LoadedSyncSettings => {
    try {
      storage.removeItem(SYNC_SETTINGS_KEY);
    } catch {
      /* ignore */
    }
    return defaults(why);
  };
  if (raw.length > 4 * MAX_TD_URL_LEN) return wipe('saved Sync settings too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return wipe('saved Sync settings were not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return wipe('saved Sync settings malformed');
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== SYNC_SETTINGS_VERSION) return wipe('saved Sync settings from an unknown version');
  const path = SYNC_PATHS.find((p) => p === rec.path);
  if (!path) return wipe('saved Sync path invalid');
  const s = sanitizeTdUrl(rec.url);
  if (!s.ok) return wipe(`saved TD URL rejected: ${s.reason}`);
  const grid = typeof rec.grid === 'boolean' ? rec.grid : defaultTdGrid(s.hostClass);
  if (Object.prototype.hasOwnProperty.call(rec, 'auth')) {
    // Someone (an old build, or a tamperer) stored a secret here. Never keep it.
    saveSyncSettings(storage, { url: s.url, path, grid });
  }
  return { url: s.url, path, grid, needsConfirm: tdUrlNeedsConfirm(s), dropped: null };
}

/**
 * Persist the Sync record. The URL is re-sanitised (an invalid one is not
 * saved) and only `{ v, url, path, grid }` is written — the auth token is
 * deliberately not part of SyncSettings. Returns false if nothing was stored.
 */
export function saveSyncSettings(storage: SyncStorage | null | undefined, settings: SyncSettings): boolean {
  if (!storage) return false;
  const s = sanitizeTdUrl(settings.url);
  if (!s.ok || !SYNC_PATHS.includes(settings.path)) return false;
  const rec = { v: SYNC_SETTINGS_VERSION, url: s.url, path: settings.path, grid: settings.grid === true };
  try {
    storage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}
