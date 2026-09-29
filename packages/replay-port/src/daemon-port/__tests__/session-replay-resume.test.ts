import type { SessionAction } from '@agent-device/contracts/session';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildReplayDivergenceResume } from '../session-replay-resume.ts';

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: 0, command: 'click', positionals: ['label="Save"'], flags: {}, ...overrides };
}

test('buildReplayDivergenceResume reports a resumable generic .ad failure', () => {
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
// --- buildReplayDivergenceResume: `resume.alternateFrom` (#1262). The
// `caution`/`manual` dual-path's SECOND ordinal (`failedIndex + 1`), present
// ONLY when a `--from failedIndex + 1` request would actually be accepted.
// Generic `.ad` plans contain no runtime variable producers or control
// wrappers, so only the empty-tail session requirement can block it. ---

test('buildReplayDivergenceResume: caution mid-plan carries alternateFrom = failedIndex + 1', () => {
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

test('buildReplayDivergenceResume: manual last-step carries alternateFrom = actions.length + 1', () => {
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
