import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  resolveReplayEntryIndex,
  type AdReplayEntryIndexParams,
  type PendingRecordAndHeal,
} from '../resume.ts';

/**
 * #1555 structural-quality review ("package-local tests... resume.ts and
 * cover its branches; counterfactual per docs/agents/testing.md on at least
 * the rejection path"): `resolveReplayEntryIndex` was previously exercised
 * only transitively, through the daemon's
 * `session-replay-runtime-plan.test.ts` (`resolveReplayPlanEntryIndex`
 * wrapping the manifest's `resolveEntryIndex` closure). This suite covers
 * the pure resume-point math directly, at package level, cheaper than the
 * daemon round trip.
 */

const PLAN_DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const ACTION_COUNT = 5;

function params(overrides: Partial<AdReplayEntryIndexParams> = {}): AdReplayEntryIndexParams {
  return {
    from: undefined,
    digest: undefined,
    pendingRecordAndHeal: undefined,
    sessionActionsLength: 0,
    ...overrides,
  };
}

test('no --from and no --plan-digest resolves to the plan start (entry index 0)', () => {
  const result = resolveReplayEntryIndex(params(), ACTION_COUNT, PLAN_DIGEST);
  assert.deepEqual(result, { ok: true, value: 0 });
});

test('--from without --plan-digest is rejected, and the reverse pairing too', () => {
  const fromOnly = resolveReplayEntryIndex(params({ from: 2 }), ACTION_COUNT, PLAN_DIGEST);
  assert.equal(fromOnly.ok, false);
  if (fromOnly.ok) throw new Error('unreachable');
  assert.match(fromOnly.message, /--from requires --plan-digest/);

  const digestOnly = resolveReplayEntryIndex(
    params({ digest: PLAN_DIGEST }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(digestOnly.ok, false);
  if (digestOnly.ok) throw new Error('unreachable');
  assert.match(digestOnly.message, /--from requires --plan-digest/);
});

test('a valid in-range --from resolves to the 0-based entry index (from - 1)', () => {
  const result = resolveReplayEntryIndex(
    params({ from: 3, digest: PLAN_DIGEST }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.deepEqual(result, { ok: true, value: 2 });
});

// ---------------------------------------------------------------------------
// Rejection: out-of-range --from.
// ---------------------------------------------------------------------------

test('rejection: --from below 1 or above the plan length (with no matching empty-tail watermark) is out of range', () => {
  const zero = resolveReplayEntryIndex(
    params({ from: 0, digest: PLAN_DIGEST }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(zero.ok, false);
  if (zero.ok) throw new Error('unreachable');
  assert.match(zero.message, /out of range for a 5-step plan/);

  // ACTION_COUNT + 1 (6) is the one legal empty-tail boundary, but ONLY with
  // a matching watermark (covered separately below) — absent one, it is out
  // of range exactly like anything past it.
  const pastEnd = resolveReplayEntryIndex(
    params({ from: ACTION_COUNT + 2, digest: PLAN_DIGEST }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(pastEnd.ok, false);
  if (pastEnd.ok) throw new Error('unreachable');
  assert.match(pastEnd.message, /out of range for a 5-step plan/);

  const emptyTailNoWatermark = resolveReplayEntryIndex(
    params({ from: ACTION_COUNT + 1, digest: PLAN_DIGEST }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(emptyTailNoWatermark.ok, false);
  if (emptyTailNoWatermark.ok) throw new Error('unreachable');
  assert.match(emptyTailNoWatermark.message, /out of range for a 5-step plan/);
});

// Counterfactual (docs/agents/testing.md): reverting describeOutOfRangeResumeFrom's
// `from <= actionCount` bound to `from <= actionCount + 1` (dropping the
// authorization gate entirely) turns this red — verified by hand, restored
// before commit. Recorded here so the proof does not have to be re-derived:
// `git stash` a local edit changing `from <= actionCount` to
// `from <= actionCount + 1` in resume.ts, re-run this file, observe the
// "rejection: --from below 1..." case fail on its `pastEnd`/`emptyTailNoWatermark`
// assertions, then `git stash pop` to restore.

test('rejection: --plan-digest that does not match the current plan digest is stale', () => {
  const result = resolveReplayEntryIndex(
    params({ from: 2, digest: OTHER_DIGEST }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.message, /does not match the current plan digest/);
});

// ---------------------------------------------------------------------------
// Empty-tail resume: the ONE ordinal beyond the plan's end (actionCount + 1),
// authorized only for the exact session/target that produced the watermark.
// ---------------------------------------------------------------------------

test('empty-tail: actionCount + 1 resolves when the watermark matches and the session has grown since the divergence', () => {
  const pendingRecordAndHeal: PendingRecordAndHeal = {
    expectedFrom: ACTION_COUNT + 1,
    actionsCountAtDivergence: 3,
  };
  const result = resolveReplayEntryIndex(
    params({
      from: ACTION_COUNT + 1,
      digest: PLAN_DIGEST,
      pendingRecordAndHeal,
      sessionActionsLength: 4, // grew past actionsCountAtDivergence
    }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.deepEqual(result, { ok: true, value: ACTION_COUNT });
});

test('empty-tail: a watermark for a DIFFERENT --from ordinal does not authorize this one', () => {
  const pendingRecordAndHeal: PendingRecordAndHeal = {
    expectedFrom: ACTION_COUNT, // not ACTION_COUNT + 1
    actionsCountAtDivergence: 3,
  };
  const result = resolveReplayEntryIndex(
    params({
      from: ACTION_COUNT + 1,
      digest: PLAN_DIGEST,
      pendingRecordAndHeal,
      sessionActionsLength: 4,
    }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.message, /out of range for a 5-step plan/);
});

// ---------------------------------------------------------------------------
// Heal semantics: the watermark alone is not enough — the session's own
// recorded action count must have grown, proving the corrective press (or
// re-recorded read) actually happened in this repair segment.
// ---------------------------------------------------------------------------

test('heal: a matching watermark with NO session growth is rejected as an unperformed record-and-heal', () => {
  const pendingRecordAndHeal: PendingRecordAndHeal = {
    expectedFrom: ACTION_COUNT + 1,
    actionsCountAtDivergence: 3,
  };
  const result = resolveReplayEntryIndex(
    params({
      from: ACTION_COUNT + 1,
      digest: PLAN_DIGEST,
      pendingRecordAndHeal,
      sessionActionsLength: 3, // unchanged since the divergence — no corrective action recorded
    }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.message, /no corrective action was\s+recorded in this repair segment/);
  assert.match(result.message, /--record/);
});

test('heal: the unperformed-record-and-heal message is scoped to the matching watermark, not a generic in-range --from', () => {
  // A mid-plan --from that never matches a pending watermark's expectedFrom
  // is not subject to the growth check at all — it is either accepted
  // (in-range) or rejected as out-of-range, never as "unperformed".
  const pendingRecordAndHeal: PendingRecordAndHeal = {
    expectedFrom: ACTION_COUNT + 1,
    actionsCountAtDivergence: 3,
  };
  const result = resolveReplayEntryIndex(
    params({
      from: 2,
      digest: PLAN_DIGEST,
      pendingRecordAndHeal,
      sessionActionsLength: 3,
    }),
    ACTION_COUNT,
    PLAN_DIGEST,
  );
  assert.deepEqual(result, { ok: true, value: 1 });
});
