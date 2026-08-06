import type { SettleObservation } from '@agent-device/contracts/interaction';
import { markSessionPartialRefsIssued } from './session-snapshot.ts';
import type { SessionState } from './types.ts';

/**
 * #1101 `--settle`: a settle observation carrying a diff hands the client refs
 * minted from the freshly stored settled tree (added lines carry them), which
 * makes the response ref-issuing like snapshot/find: it activates a PARTIAL
 * frame (ADR 0014) authorizing exactly those bodies, and the stored tree's
 * generation rides inside the settle payload for MCP per-ref pinning. Without a
 * diff — never captured, or sparse-quality capture that was not stored — nothing
 * was issued and the frame is left as the action's leaf seam expired it.
 *
 * Shared by both settle-carrying routes so the rule is stated once: the
 * interaction route (press/click/fill/longpress) and the generic route
 * (scroll/back, #1638) publish refs on identical terms.
 */
export function issueSettleRefs(
  session: SessionState,
  settle: SettleObservation | undefined,
): number | undefined {
  if (!settle?.diff) return undefined;
  // ADR 0014: a settled diff publishes the refs it exposed, so it activates a
  // PARTIAL frame authorizing exactly those bodies (not the whole tree).
  markSessionPartialRefsIssued(session, collectSettleIssuedRefBodies(settle));
  return session.snapshotGeneration;
}

/** The reusable refs a settled diff exposed: added diff lines, `refs`, `tail`. */
function collectSettleIssuedRefBodies(settle: SettleObservation): string[] {
  const bodies: string[] = [];
  for (const line of settle.diff?.lines ?? []) {
    if (line.ref) bodies.push(line.ref);
  }
  for (const entry of settle.refs ?? []) bodies.push(entry.ref);
  for (const entry of settle.tail ?? []) bodies.push(entry.ref);
  return bodies;
}
