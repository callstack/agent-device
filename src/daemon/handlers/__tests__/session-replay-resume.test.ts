import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildReplayDivergenceResume,
  evaluateReplayResumePreflight,
  stampPendingRecordAndHealWatermark,
} from '../session-replay-resume.ts';
import type { SessionAction, SessionState } from '../../types.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: 0, command: 'click', positionals: ['label="Save"'], flags: {}, ...overrides };
}

// --- from === 1: nothing skipped, always allowed ---

test('from 1 is always allowed, even when step 1 itself is control flow', () => {
  const actions: SessionAction[] = [
    action({
      command: 'back',
      positionals: [],
      replayControl: { kind: 'retry', maxRetries: 2, actions: [action({ command: 'back' })] },
    }),
    action({ command: 'click' }),
  ];
  assert.deepEqual(evaluateReplayResumePreflight({ from: 1, actions }), { allowed: true });
});

// --- plain steps: always resumable ---

test('resuming after only plain, non-control-flow steps is allowed', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: 'click', positionals: ['label="Continue"'] }),
    action({ command: 'click', positionals: ['label="Save"'] }),
  ];
  assert.deepEqual(evaluateReplayResumePreflight({ from: 3, actions }), { allowed: true });
});

// --- control flow in the skipped range ---

test('rejects when a skipped step is a retry block', () => {
  const actions: SessionAction[] = [
    action({
      command: 'back',
      positionals: [],
      replayControl: { kind: 'retry', maxRetries: 2, actions: [action({ command: 'back' })] },
    }),
    action({ command: 'click' }),
  ];
  const result = evaluateReplayResumePreflight({ from: 2, actions });
  assert.equal(result.allowed, false);
  if (result.allowed) return;
  assert.match(result.reason, /control flow/);
  assert.match(result.reason, /retry/);
});

test('rejects when a skipped step is a maestroRunFlowWhen block', () => {
  const actions: SessionAction[] = [
    action({
      command: 'back',
      positionals: [],
      replayControl: {
        kind: 'maestroRunFlowWhen',
        mode: 'visible',
        selector: 'label="Continue"',
        actions: [action({ command: 'back' })],
      },
    }),
    action({ command: 'click' }),
  ];
  const result = evaluateReplayResumePreflight({ from: 2, actions });
  assert.equal(result.allowed, false);
  if (result.allowed) return;
  assert.match(result.reason, /maestroRunFlowWhen/);
});

// --- control flow AS the resume target ---

test('rejects when the resume target itself is a control-flow block', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({
      command: 'back',
      positionals: [],
      replayControl: { kind: 'retry', maxRetries: 1, actions: [action({ command: 'back' })] },
    }),
  ];
  const result = evaluateReplayResumePreflight({ from: 2, actions });
  assert.equal(result.allowed, false);
  if (result.allowed) return;
  assert.match(result.reason, /cannot be safely resumed into/);
});

// --- outputEnv-producing skipped steps ---

test('rejects when a skipped step can produce outputEnv values (maestro runScript)', () => {
  const actions: SessionAction[] = [
    action({ command: '__maestroRunScript', positionals: ['./setup.js'] }),
    action({ command: 'click' }),
  ];
  const result = evaluateReplayResumePreflight({ from: 2, actions });
  assert.equal(result.allowed, false);
  if (result.allowed) return;
  assert.match(result.reason, /outputEnv/);
});

test('an outputEnv-producing step AT the resume target itself (not skipped) is fine', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: '__maestroRunScript', positionals: ['./setup.js'] }),
  ];
  // Resuming AT the runScript step re-executes it (it is not skipped), so its
  // outputEnv is produced fresh, not assumed from a prior run.
  assert.deepEqual(evaluateReplayResumePreflight({ from: 2, actions }), { allowed: true });
});

// --- same child index recurring under different parents / repeated plan indices ---
// (Resume addressing is purely by top-level plan index; two structurally
// distinct occurrences of the same command are still distinguished correctly
// because each occupies its own array slot.)

test('expanded repeats occupy distinct, independently addressable plan indices', () => {
  const actions: SessionAction[] = [
    action({ command: 'click', positionals: ['label="Item"'] }),
    action({ command: 'click', positionals: ['label="Item"'] }),
    action({ command: 'click', positionals: ['label="Item"'] }),
  ];
  // Resuming at the 3rd occurrence skips the first two identical-looking
  // steps; neither is control-flow or outputEnv-producing, so it is allowed.
  assert.deepEqual(evaluateReplayResumePreflight({ from: 3, actions }), { allowed: true });
});

// --- buildReplayDivergenceResume: report-facing wrapper ---

test('buildReplayDivergenceResume reports allowed:true with from/planDigest for a safe failed step', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: 'click', positionals: ['label="Save"'] }),
  ];
  // `state-repair` carries no `alternateFrom` (no recorded-action alternate),
  // so this stays a clean base-shape assertion — the caution/manual
  // `alternateFrom` cases are covered by the dedicated tests below.
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'state-repair',
    sessionExists: true,
  });
  assert.deepEqual(resume, { allowed: true, from: 2, planDigest: 'abc123' });
});

test('buildReplayDivergenceResume reports allowed:false with from/planDigest/reason when unsafe', () => {
  const actions: SessionAction[] = [
    action({
      command: 'back',
      positionals: [],
      replayControl: { kind: 'retry', maxRetries: 1, actions: [action({ command: 'back' })] },
    }),
    action({ command: 'click' }),
  ];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'manual',
    sessionExists: true,
  });
  assert.equal(resume.allowed, false);
  assert.equal(resume.from, 2);
  assert.equal(resume.planDigest, 'abc123');
  if (resume.allowed) return;
  assert.ok(resume.reason.length > 0);
});

// --- repairHint 'record-and-heal' shifts `from` to failedIndex + 1 (ADR 0012
// decision 6, R2): the agent already performed the diverged step manually, so
// resuming AT it would re-diverge on the exact same step. ---

test('buildReplayDivergenceResume with repairHint record-and-heal resumes AFTER the failed step', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: 'click', positionals: ['label="Save"'] }),
    action({ command: 'click', positionals: ['label="Confirm"'] }),
  ];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'record-and-heal',
    sessionExists: true,
  });
  assert.deepEqual(resume, { allowed: true, from: 3, planDigest: 'abc123' });
});

test('buildReplayDivergenceResume with repairHint record-and-heal on the LAST plan step is a legal empty-tail resume', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: 'click', positionals: ['label="Save"'] }),
  ];
  // failedIndex 2 (the last of 2 actions) shifts to from 3 = actions.length +
  // 1 — there is no step 3 to run, but that is not an error: the runtime
  // executes zero steps and reaches the normal end-of-plan completion path.
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'record-and-heal',
    sessionExists: true,
  });
  assert.deepEqual(resume, { allowed: true, from: 3, planDigest: 'abc123' });
});

test('buildReplayDivergenceResume with repairHint record-and-heal still rejects a skipped control-flow range', () => {
  const actions: SessionAction[] = [
    action({
      command: 'back',
      positionals: [],
      replayControl: { kind: 'retry', maxRetries: 1, actions: [action({ command: 'back' })] },
    }),
    action({ command: 'click' }),
    action({ command: 'click' }),
  ];
  // failedIndex 2 shifts to from 3, which still skips step 1's control-flow
  // block — the shift does not bypass the existing skip-safety preflight.
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'record-and-heal',
    sessionExists: true,
  });
  assert.equal(resume.allowed, false);
  assert.equal(resume.from, 3);
  if (resume.allowed) return;
  assert.match(resume.reason, /control flow/);
});

// --- buildReplayDivergenceResume: `resume.alternateFrom` (#1262). The
// `caution`/`manual` dual-path's SECOND ordinal (`failedIndex + 1`), present
// ONLY when a `--from failedIndex + 1` request would actually be accepted —
// i.e. `evaluateReplayResumePreflight({ from: failedIndex + 1 })` passes,
// which additionally requires the DIVERGED step itself to be skip-safe. This
// closes the parity bug where the text renderer offered `--from N + 1` based
// on `N`'s preflight (which does not check step `N`'s own skip-safety). ---

test('buildReplayDivergenceResume: caution mid-plan (skip-safe diverged step) carries alternateFrom = failedIndex + 1', () => {
  const actions: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: 'click' }),
    action({ command: 'click' }),
  ];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'caution',
    sessionExists: true,
  });
  assert.equal(resume.allowed, true);
  assert.equal(resume.from, 2); // unshifted
  if (!resume.allowed) return;
  assert.equal(resume.alternateFrom, 3);
});

test('buildReplayDivergenceResume: manual last-step (skip-safe diverged step) carries alternateFrom = actions.length + 1', () => {
  const actions: SessionAction[] = [action({ command: 'open' }), action({ command: 'click' })];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'manual',
    sessionExists: true,
  });
  assert.equal(resume.allowed, true);
  assert.equal(resume.from, 2);
  if (!resume.allowed) return;
  assert.equal(resume.alternateFrom, 3); // empty-tail ordinal
});

test('buildReplayDivergenceResume: caution whose diverged step is a runScript carries NO alternateFrom (mid-plan AND last-step)', () => {
  // The `N + 1` alternate would skip the runScript (outputEnv producer) at
  // step N, which `evaluateReplayResumePreflight({ from: N + 1 })` refuses —
  // so alternateFrom is absent even though resuming AT N stays allowed.
  const midPlan: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: '__maestroRunScript', positionals: ['./setup.js'] }),
    action({ command: 'click' }),
  ];
  const midPlanResume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions: midPlan,
    planDigest: 'abc123',
    repairHint: 'caution',
    sessionExists: true,
  });
  assert.equal(midPlanResume.allowed, true); // resuming AT 2 is fine
  assert.equal(midPlanResume.from, 2);
  if (!midPlanResume.allowed) return;
  assert.equal(midPlanResume.alternateFrom, undefined);

  const lastStep: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: '__maestroRunScript', positionals: ['./setup.js'] }),
  ];
  const lastStepResume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions: lastStep,
    planDigest: 'abc123',
    repairHint: 'caution',
    sessionExists: true,
  });
  assert.equal(lastStepResume.allowed, true);
  assert.equal(lastStepResume.from, 2);
  if (!lastStepResume.allowed) return;
  assert.equal(lastStepResume.alternateFrom, undefined);
});

test('buildReplayDivergenceResume: manual whose diverged step is inside runtime control flow carries NO alternateFrom (mid-plan AND last-step)', () => {
  // A control-flow diverged step is not even resumable AT (you cannot resume
  // INTO a retry/runFlowWhen wrapper), so `resume.allowed` is false and the
  // `allowed: false` shape has no `alternateFrom` field at all — the key
  // invariant is that no `N + 1` alternate is ever advertised for it.
  const controlStep = () =>
    action({
      command: 'back',
      positionals: [],
      replayControl: { kind: 'retry', maxRetries: 1, actions: [action({ command: 'back' })] },
    });
  const midPlan: SessionAction[] = [
    action({ command: 'open' }),
    controlStep(),
    action({ command: 'click' }),
  ];
  const midPlanResume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions: midPlan,
    planDigest: 'abc123',
    repairHint: 'manual',
    sessionExists: true,
  });
  assert.equal('alternateFrom' in midPlanResume, false);

  const lastStep: SessionAction[] = [action({ command: 'open' }), controlStep()];
  const lastStepResume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions: lastStep,
    planDigest: 'abc123',
    repairHint: 'manual',
    sessionExists: true,
  });
  assert.equal('alternateFrom' in lastStepResume, false);
});

test('buildReplayDivergenceResume: record-and-heal and state-repair never carry alternateFrom (no separate recorded-action alternate)', () => {
  const actions: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: 'click' }),
    action({ command: 'click' }),
  ];
  for (const repairHint of ['record-and-heal', 'state-repair'] as const) {
    const resume = buildReplayDivergenceResume({
      failedIndex: 2,
      actions,
      planDigest: 'abc123',
      repairHint,
      sessionExists: true,
    });
    assert.equal(resume.allowed, true);
    if (!resume.allowed) return;
    assert.equal(resume.alternateFrom, undefined, `expected no alternateFrom for ${repairHint}`);
  }
});

// --- #1262 (re-review): the EMPTY-TAIL alternate (`failedIndex + 1 >
// actions.length`) is authorizable only via the `pendingRecordAndHeal`
// watermark, which can only be stamped on a LIVE session. With NO session — a
// one-step `open` failure, or a session closed mid-replay — advertising
// `--from actions.length + 1` would be rejected as out of range, so it must
// not be emitted. A MID-PLAN alternate (in range) needs no watermark and stays
// session-independent. ---

test('buildReplayDivergenceResume: LAST-step caution/manual with NO session carries NO alternateFrom (empty-tail needs a watermark, which needs a session)', () => {
  const actions: SessionAction[] = [action({ command: 'open' }), action({ command: 'click' })];
  for (const repairHint of ['caution', 'manual'] as const) {
    const resume = buildReplayDivergenceResume({
      failedIndex: 2, // last step → alternate would be the one-past-end ordinal 3
      actions,
      planDigest: 'abc123',
      repairHint,
      sessionExists: false,
    });
    assert.equal(resume.allowed, true); // resuming AT the failed step (2) is still fine
    if (!resume.allowed) return;
    assert.equal(
      resume.alternateFrom,
      undefined,
      `expected no empty-tail alternateFrom without a session for ${repairHint}`,
    );
  }
});

test('buildReplayDivergenceResume: MID-PLAN caution/manual with NO session STILL carries alternateFrom (in-range, no watermark needed)', () => {
  // 3-step plan; failedIndex 2 → alternate 3 is IN RANGE (<= actions.length),
  // so it needs no watermark and is emitted regardless of session existence.
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
      sessionExists: false,
    });
    assert.equal(resume.allowed, true);
    if (!resume.allowed) return;
    assert.equal(resume.alternateFrom, 3, `expected mid-plan alternateFrom for ${repairHint}`);
  }
});

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

test('stampPendingRecordAndHealWatermark does not stamp for a LAST-step caution/manual divergence when the N + 1 target is not itself preflight-safe', () => {
  // failedIndex (3) IS the last step, but skipping it (to reach N + 1 = 4)
  // requires also skipping step 2 (an outputEnv-producing maestro runScript),
  // which cannot be proven safe — even though `resume.from` (unshifted, at
  // N = 3 — resuming AT it, not skipping it) is independently fine.
  const actions: SessionAction[] = [
    action({ command: 'open' }),
    action({ command: '__maestroRunScript', positionals: ['./setup.js'] }),
    action({ command: 'click' }),
  ];
  const resume = buildReplayDivergenceResume({
    failedIndex: 3,
    actions,
    planDigest: 'abc123',
    repairHint: 'caution',
    sessionExists: true,
  });
  const session = sessionWithActions(2);
  stampPendingRecordAndHealWatermark({
    session,
    resume,
    repairHint: 'caution',
    failedIndex: 3,
    actions,
  });
  assert.equal(session.pendingRecordAndHeal, undefined);
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
