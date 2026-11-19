/**
 * One deterministic lifetime fixture shared by every test that needs birth-token evidence, so a
 * format change edits one place. `LIFETIME_TOKEN` is a canonical provenanced POSIX token;
 * `STALE_LIFETIME_TOKEN` is the same format naming a different lifetime; `LEGACY_RAW_START_TIME`
 * is a raw C-form rendering as a pre-canonicalization build recorded it — unqualified, so it is
 * `unknown` against any read and proves neither match nor difference.
 */
export const LIFETIME_TOKEN = 'posix:1794944547000';
export const STALE_LIFETIME_TOKEN = 'posix:1794944548000';
export const LEGACY_RAW_START_TIME = 'Tue Nov 17 19:42:27 2026';

/** A C-form `ps -o lstart=` row (UTC-pinned probe input) that canonicalizes to {@link LIFETIME_TOKEN}. */
export const LIFETIME_C_FORM = 'Tue Nov 17 19:42:27 2026';

/**
 * A stale token in the same provenanced format as `live` (the one a reuse proof needs), or a
 * provenanced token when `live` is raw or unreadable.
 */
export function staleBirthTokenLike(live: string | null | undefined): string {
  if (live?.startsWith('linux:')) return 'linux:00000000-0000-4000-8000-000000000000:999999999';
  if (live?.startsWith('posix:')) return 'posix:1';
  if (live !== null && live !== undefined && /^\d{21}$/.test(live)) return '00000000000000000000';
  return STALE_LIFETIME_TOKEN;
}
