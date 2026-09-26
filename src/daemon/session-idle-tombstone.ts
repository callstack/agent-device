import fs from 'node:fs';
import path from 'node:path';

/**
 * #2833: the bounded marker an idle-expired session leaves behind, so the next command that finds no
 * session on that key answers `SESSION_NOT_FOUND` with a typed `details.reason` naming why the
 * session is gone and its device released, instead of the bare "Run open first" that reads like the
 * agent never opened anything.
 *
 * Same shape and lifetime as the repair tombstone (`src/session-repair-tombstone.ts`): keyed by the
 * session's own store key, and bounded by `expiresAt` so an old marker never shadows an unrelated
 * future session that happens to reuse the name.
 */
export type IdleSessionTombstone = {
  owner: string;
  expiredAtMs: number;
  expiresAt: number;
  /** The inactivity window that was in force when the session was expired. */
  idleExpiryMs: number;
  /** The device the expired session released, when it held a host-global claim. */
  deviceKey?: string;
};

const IDLE_SESSION_TOMBSTONE_FILENAME = 'idle-expiry.json';

/** The tombstone file inside one session directory. Single owner of the file name. */
export function resolveIdleSessionTombstonePath(sessionDir: string): string {
  return path.join(sessionDir, IDLE_SESSION_TOMBSTONE_FILENAME);
}

/**
 * Parses/validates a tombstone file at `tombstonePath`; `undefined` if missing, malformed, or expired.
 *
 * Every field is checked against the range the writer could have produced rather than just its type,
 * because `JSON.parse` accepts numbers no clock can hold: `1e400` parses to `Infinity`, which is after
 * every date and would let one damaged marker explain this session key's absences forever. The device
 * key is checked for the same reason — it is quoted back to the agent as the device to re-claim, so a
 * value the writer never produces must not reach that sentence.
 */
export function readIdleSessionTombstoneFile(
  tombstonePath: string,
): IdleSessionTombstone | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(tombstonePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: IdleSessionTombstone;
  try {
    parsed = JSON.parse(raw) as IdleSessionTombstone;
  } catch {
    return undefined;
  }
  if (typeof parsed?.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return undefined;
  if (parsed.expiresAt <= Date.now()) return undefined;
  if (typeof parsed.owner !== 'string') return undefined;
  if (!isFiniteTimestamp(parsed.expiredAtMs) || !isFiniteTimestamp(parsed.idleExpiryMs)) {
    return undefined;
  }
  if (parsed.deviceKey !== undefined && typeof parsed.deviceKey !== 'string') return undefined;
  return parsed;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
