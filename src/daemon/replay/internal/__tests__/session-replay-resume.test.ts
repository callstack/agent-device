import type { SessionAction } from '@agent-device/contracts/session';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildReplayDivergenceResume } from '@agent-device/replay-port/session-replay-resume';
import { stampPendingRecordAndHealWatermark } from '../../../session-replay-coordinator.ts';
import type { SessionState } from '../../../session-state.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: 0, command: 'click', positionals: ['label="Save"'], flags: {}, ...overrides };
}

// --- stampPendingRecordAndHealWatermark (#1262): the watermark is now ALSO
// stamped for `caution`/`manual`, but ONLY for the LAST-step empty-tail
// alternate (`failedIndex === actions.length`, targeting `failedIndex + 1`).
// A MID-PLAN `--from N + 1` was already unconditionally legal (in range) and
// un-gated for these hints before #1262 — an agent may legitimately decide
// to skip a `caution`/`manual` diverged step without repairing it, unlike
// `record-and-heal`'s mandatory-repair contract — and that pattern must not
// regress. ---

function sessionWithActions(count: number): SessionState {
  const session = makeIosSession('default');
  session.actions = Array.from({ length: count }, () => action());
  return session;
}

test('stampPendingRecordAndHealWatermark stamps record-and-heal at its own (already-shifted) resume.from, mid-plan or last-step', () => {
  // Mid-plan: failedIndex (2) is NOT the plan's last step (3 actions total).
  const midPlanActions: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: 'click' }),
    action({ command: 'click' }),
  ];
  const midPlanResume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions: midPlanActions,
    planDigest: 'abc123',
    repairHint: 'record-and-heal',
    sessionExists: true,
  });
  const midPlanSession = sessionWithActions(1);
  stampPendingRecordAndHealWatermark({
    session: midPlanSession,
    resume: midPlanResume,
    repairHint: 'record-and-heal',
    failedIndex: 2,
    actions: midPlanActions,
  });
  assert.deepEqual(midPlanSession.pendingRecordAndHeal, {
    expectedFrom: 3,
    actionsCountAtDivergence: 1,
  });

  // Last-step: failedIndex (2) IS the plan's last step (2 actions total).
  const lastStepActions: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: 'click' }),
  ];
  const lastStepResume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions: lastStepActions,
    planDigest: 'abc123',
    repairHint: 'record-and-heal',
    sessionExists: true,
  });
  const lastStepSession = sessionWithActions(1);
  stampPendingRecordAndHealWatermark({
    session: lastStepSession,
    resume: lastStepResume,
    repairHint: 'record-and-heal',
    failedIndex: 2,
    actions: lastStepActions,
  });
  assert.deepEqual(lastStepSession.pendingRecordAndHeal, {
    expectedFrom: 3,
    actionsCountAtDivergence: 1,
  });
});

test('stampPendingRecordAndHealWatermark stamps caution at the LAST-step empty-tail (failedIndex + 1), NOT at its own unshifted resume.from', () => {
  const actions: SessionAction[] = [action({ command: 'open' }), action({ command: 'click' })];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'caution',
    sessionExists: true,
  });
  assert.equal(resume.from, 2); // unshifted — item 1 of #1262's resolution
  const session = sessionWithActions(1);
  stampPendingRecordAndHealWatermark({
    session,
    resume,
    repairHint: 'caution',
    failedIndex: 2, // the plan's LAST step (2 actions total)
    actions,
  });
  // The watermark targets failedIndex + 1 (3) — a DIFFERENT ordinal than
  // resume.from (2) — never blocking `--from 2` itself.
  assert.deepEqual(session.pendingRecordAndHeal, {
    expectedFrom: 3,
    actionsCountAtDivergence: 1,
  });
});

test('stampPendingRecordAndHealWatermark stamps manual the same way as caution at the last step', () => {
  const actions: SessionAction[] = [action({ command: 'open' }), action({ command: 'click' })];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'manual',
    sessionExists: true,
  });
  const session = sessionWithActions(1);
  stampPendingRecordAndHealWatermark({
    session,
    resume,
    repairHint: 'manual',
    failedIndex: 2,
    actions,
  });
  assert.deepEqual(session.pendingRecordAndHeal, {
    expectedFrom: 3,
    actionsCountAtDivergence: 1,
  });
});

test('stampPendingRecordAndHealWatermark does NOT stamp for a MID-PLAN caution/manual divergence — that N + 1 was already unconditionally legal and stays un-gated', () => {
  // 3-step plan; failedIndex (2) is NOT the last step (3).
  const actions: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: 'click' }),
    action({ command: 'click' }),
  ];
  for (const repairHint of ['caution', 'manual'] as const) {
    const resume = buildReplayDivergenceResume({
      failedIndex: 2,
      actions,
      planDigest: 'abc123',
      repairHint,
      sessionExists: true,
    });
    const session = sessionWithActions(1);
    stampPendingRecordAndHealWatermark({ session, resume, repairHint, failedIndex: 2, actions });
    assert.equal(
      session.pendingRecordAndHeal,
      undefined,
      `expected no watermark for ${repairHint}`,
    );
  }
});

test('stampPendingRecordAndHealWatermark never stamps for state-repair (not in the extended eligible set)', () => {
  const actions: SessionAction[] = [action({ command: 'open' }), action({ command: 'click' })];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'state-repair',
    sessionExists: true,
  });
  const session = sessionWithActions(1);
  stampPendingRecordAndHealWatermark({
    session,
    resume,
    repairHint: 'state-repair',
    failedIndex: 2,
    actions,
  });
  assert.equal(session.pendingRecordAndHeal, undefined);
});

test('stampPendingRecordAndHealWatermark clears a stale watermark from an earlier divergence when the new one is ineligible', () => {
  const actions: SessionAction[] = [action({ command: 'open' }), action({ command: 'click' })];
  const session = sessionWithActions(1);
  session.pendingRecordAndHeal = { expectedFrom: 3, actionsCountAtDivergence: 0 };
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'state-repair',
    sessionExists: true,
  });
  stampPendingRecordAndHealWatermark({
    session,
    resume,
    repairHint: 'state-repair',
    failedIndex: 2,
    actions,
  });
  assert.equal(session.pendingRecordAndHeal, undefined);
});
