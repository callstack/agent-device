import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildReplayDivergenceResume,
  evaluateReplayResumePreflight,
} from '../session-replay-resume.ts';
import type { SessionAction } from '../../types.ts';

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
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
    repairHint: 'manual',
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
  });
  assert.equal(resume.allowed, false);
  assert.equal(resume.from, 3);
  if (resume.allowed) return;
  assert.match(resume.reason, /control flow/);
});
