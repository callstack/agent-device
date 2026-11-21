/**
 * Process start times for tests. `LIFETIME_TOKEN` is a macOS start token; `STALE_LIFETIME_TOKEN`
 * names another lifetime from the same source. `LEGACY_RAW_START_TIME` is the raw `ps` string an
 * older release recorded, which proves neither a match nor a difference.
 */
export const LIFETIME_TOKEN = 'posix:1794944547000';
export const STALE_LIFETIME_TOKEN = 'posix:1794944548000';
export const LEGACY_RAW_START_TIME = 'Tue Nov 17 19:42:27 2026';

/** A token from the same source as `live` that names another lifetime, as a reuse proof needs. */
export function staleBirthTokenLike(live: string | null | undefined): string {
  if (live?.startsWith('linux:')) return 'linux:00000000-0000-4000-8000-000000000000:999999999';
  if (live?.startsWith('posix:')) return 'posix:1000';
  if (live !== null && live !== undefined && /^\d{21}$/.test(live)) return '000000000000000000000';
  return STALE_LIFETIME_TOKEN;
}
