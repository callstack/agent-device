import { createHash } from 'node:crypto';

/**
 * Revyl's `start_device` takes a caller-generated `session_id` and uses it as the session's
 * canonical identity, which is what Revyl's own clients do for a hosted session. Deriving it from
 * the lease id therefore gives the runtime a durable identity for one lease: an expired-lease
 * recovery in a process that never started the device can name the session it has to stop.
 *
 * It is a UUID because that is the field's declared format, and it is a hash rather than the lease
 * id itself because two daemons that rent for the same account must derive the same id for the same
 * lease and never collide across providers.
 */
const REVYL_SESSION_ID_NAMESPACE = 'agent-device:revyl:session:v1';

/** Revyl's UUID regex accepts lowercase hex with the version and variant bits set. */
export function revylSessionIdForLease(leaseId: string): string {
  const digest = createHash('sha256')
    .update(`${REVYL_SESSION_ID_NAMESPACE}:${leaseId}`)
    .digest('hex');
  const hex = `${digest.slice(0, 32)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
