import type { DaemonResponseData } from '@agent-device/kernel/contracts';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { PRISTINE_REF_FRAME, type RefFrame } from './ref-frame-slot.ts';
import type { SessionState } from './session-state.ts';

/**
 * Ergonomics advisory for the ADR 0014 snapshot-per-action workflow: a caller that
 * re-captures a COMPLETE snapshot before every single action, because each action
 * expires the ref frame and plain refs then need a fresh complete publication.
 * Selectors (or a settled diff from `--settle`) act without any snapshot, so a
 * session stuck in this rhythm pays the dominant capture cost per action.
 *
 * The advisory is a hint on the snapshot response, never an error, and it owns no
 * frame semantics: it only OBSERVES the transitions `ref-frame.ts` already owns.
 * `expireRefFrame` reports a device side effect (one per logical command, so
 * `--count` series count once), `activateCompleteRefFrame` reports the only
 * complete-namespace publication, and a partial publication just carries the
 * counters across its frame replacement.
 *
 * The counters live in a daemon-private `WeakMap` keyed by the frame VALUE, the
 * same pattern as `ref-frame.ts`'s runtime revisions. A frame is replaced whole on
 * every transition, so each hook rekeys the counters onto the frame the session
 * holds next; the entry dies with the session's last frame. Nothing is ever keyed
 * under the shared pristine frame, so sessions that never issued refs share no
 * state. This keeps the counters out of `SessionState`, whose write claims R10
 * freezes.
 *
 * One full snapshot followed by exactly one mutation and another full snapshot is
 * one round. Any other gap between complete snapshots (no mutation, or two or more)
 * is not snapshot-per-action and resets the consecutive count. After
 * {@link ADVISORY_ROUNDS_THRESHOLD} consecutive rounds, the next complete-snapshot
 * response carries one hint line through the shared response-warnings channel
 * (`data.warnings`), which the CLI snapshot text renders as a notice via
 * `buildSnapshotNotices`.
 */
type RefFrameAdvisoryCounters = {
  /** Device side effects observed since the last complete-snapshot publication. */
  mutationsSinceSnapshot: number;
  /** Consecutive full-snapshot → single-mutation → full-snapshot rounds. */
  rounds: number;
  /** One-shot: the next complete-snapshot response must carry the hint. */
  pendingHint: boolean;
};

const ADVISORY_ROUNDS_THRESHOLD = 3;

const FRESH_ADVISORY: RefFrameAdvisoryCounters = {
  mutationsSinceSnapshot: 0,
  rounds: 0,
  pendingHint: false,
};

const advisoryByFrame = new WeakMap<RefFrame, RefFrameAdvisoryCounters>();

function readAdvisory(frame: RefFrame): RefFrameAdvisoryCounters {
  return advisoryByFrame.get(frame) ?? FRESH_ADVISORY;
}

/** Rekeys the counters onto the frame the session holds next; the replaced frame dies. */
function carryAdvisory(
  previous: RefFrame,
  current: RefFrame,
  counters: RefFrameAdvisoryCounters,
): void {
  advisoryByFrame.delete(previous);
  advisoryByFrame.set(current, counters);
}

/**
 * Called by `expireRefFrame` at each device side-effect seam, so the counter keeps
 * step with ADR 0014's definition of "the device may have acted". An already-expired
 * frame is returned as is by that seam, so repeated effects accumulate on the same
 * frame key.
 */
export function recordRefFrameAdvisoryMutation(previous: RefFrame, current: RefFrame): void {
  const counters = readAdvisory(previous);
  carryAdvisory(previous, current, {
    ...counters,
    mutationsSinceSnapshot: counters.mutationsSinceSnapshot + 1,
  });
}

/**
 * Called by `activateCompleteRefFrame`, the only complete-namespace publication.
 * Exactly one mutation since the previous complete snapshot extends the rhythm; any
 * other gap resets it. A snapshot that reissues nothing (a `@`-scoped capture that
 * kept the stored tree) never reaches this hook, so it neither extends nor resets.
 */
export function recordRefFrameAdvisoryCompleteSnapshot(
  previous: RefFrame,
  current: RefFrame,
): void {
  const counters = readAdvisory(previous);
  const rounds = counters.mutationsSinceSnapshot === 1 ? counters.rounds + 1 : 0;
  carryAdvisory(previous, current, {
    mutationsSinceSnapshot: 0,
    rounds,
    pendingHint: rounds >= ADVISORY_ROUNDS_THRESHOLD,
  });
}

/**
 * Called by a partial publication (`activatePartialRefFrame`): a `find` or settled
 * diff between snapshots is neither a complete snapshot nor an action, so the
 * rhythm carries across the frame replacement unchanged.
 */
export function carryRefFrameAdvisoryAcrossPublication(
  previous: RefFrame,
  current: RefFrame,
): void {
  if (previous === current) return;
  carryAdvisory(previous, current, readAdvisory(previous));
}

/**
 * Consumes the one-shot flag on every user-facing snapshot/diff response, win or
 * lose, so a hint armed by a dispatch that later failed cannot leak onto an
 * unrelated response. Appends the hint line only on a complete-snapshot response,
 * where `buildSnapshotNotices` renders `data.warnings` as notices.
 */
export function applyRefFrameAdvisoryHint(params: {
  session: SessionState | undefined;
  data: DaemonResponseData;
  completeSnapshotResponse: boolean;
}): DaemonResponseData {
  const { session, data, completeSnapshotResponse } = params;
  if (!session) return data;
  // Read-only: the session's current frame, pristine before anything issued (the
  // same accessor `ref-frame.ts` exposes; imported there would be a cycle).
  const frame = session.refFrame ?? PRISTINE_REF_FRAME;
  const counters = advisoryByFrame.get(frame);
  if (!counters) return data;
  advisoryByFrame.set(frame, { ...counters, pendingHint: false });
  if (!completeSnapshotResponse || !counters.pendingHint) return data;
  return {
    ...data,
    warnings: [...readResponseWarnings(data), snapshotPerActionHint(counters.rounds)],
  };
}

function snapshotPerActionHint(rounds: number): string {
  return [
    `Hint: the last ${rounds} snapshots in a row each covered one action.`,
    'Every action expires the snapshot refs, so each action forced a fresh full snapshot.',
    'Target the action with a selector (id, label, role, or text), or run it with --settle and continue from its diff, to act without a new snapshot.',
  ].join(' ');
}
