import assert from 'node:assert/strict';
import { test } from 'vitest';
import { activateCompleteRefFrame, activatePartialRefFrame, expireRefFrame } from '../ref-frame.ts';
import { applyRefFrameAdvisoryHint } from '../ref-frame-advisory.ts';
import type { DaemonResponseData } from '@agent-device/kernel/contracts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import type { SessionState } from '../session-state.ts';

function session(): SessionState {
  return makeIosSession('ref-frame-advisory-test');
}

function data(warnings?: string[]): DaemonResponseData {
  return warnings ? { warnings } : {};
}

function snapshot(s: SessionState): void {
  activateCompleteRefFrame(s);
}

function action(s: SessionState): void {
  expireRefFrame(s);
}

function renderedHints(s: SessionState): string[] {
  const applied = applyRefFrameAdvisoryHint({
    session: s,
    data: data(),
    completeSnapshotResponse: true,
  });
  const warnings = applied.warnings;
  return Array.isArray(warnings)
    ? (warnings as string[]).filter((line) => line.startsWith('Hint: '))
    : [];
}

/** `snapshot -> action -> snapshot`, the unit the advisory counts. A round CLOSES on a snapshot. */
function closedRound(s: SessionState): void {
  action(s);
  snapshot(s);
}

test('two closed rounds render no hint', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  assert.deepEqual(renderedHints(s), []);
});

test('a third consecutive closed round arms the one-shot hint', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  closedRound(s);
  const hints = renderedHints(s);
  assert.equal(hints.length, 1);
  assert.match(hints[0]!, /^Hint: the last 3 snapshots in a row each covered one action\./);
  assert.match(hints[0]!, /Target the action with a selector/);
});

test('the hint fires once', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  closedRound(s);
  assert.equal(renderedHints(s).length, 1);
  assert.equal(renderedHints(s).length, 0);
});

test('a partial publication between snapshots carries the rhythm unchanged', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  activatePartialRefFrame(s, new Set(['e1']));
  closedRound(s);
  const hints = renderedHints(s);
  assert.equal(hints.length, 1);
  assert.match(hints[0]!, /^Hint: the last 3 snapshots/);
});

test('a snapshot with no action since the previous one resets the rhythm', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  snapshot(s);
  closedRound(s);
  assert.deepEqual(renderedHints(s), []);
});

test('two actions between snapshots reset the rhythm', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  action(s);
  action(s);
  snapshot(s);
  closedRound(s);
  assert.deepEqual(renderedHints(s), []);
});

test('actions alone never arm the hint', () => {
  const s = session();
  action(s);
  action(s);
  action(s);
  assert.deepEqual(renderedHints(s), []);
});

test('a snapshot response for a session with no counters carries nothing', () => {
  const s = session();
  assert.deepEqual(renderedHints(s), []);
});

test('a session-less response is returned unchanged', () => {
  const applied = applyRefFrameAdvisoryHint({
    session: undefined,
    data: data(),
    completeSnapshotResponse: true,
  });
  assert.deepEqual(applied, {});
});

test('the hint appends after existing response warnings', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  closedRound(s);
  const applied = applyRefFrameAdvisoryHint({
    session: s,
    data: data(['capture degraded']),
    completeSnapshotResponse: true,
  });
  const warnings = applied.warnings as string[];
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0], 'capture degraded');
  assert.match(warnings[1]!, /^Hint: /);
});

test('a non-complete response consumes the armed hint without rendering it', () => {
  const s = session();
  snapshot(s);
  closedRound(s);
  closedRound(s);
  closedRound(s);
  const consumed = applyRefFrameAdvisoryHint({
    session: s,
    data: data(),
    completeSnapshotResponse: false,
  });
  assert.deepEqual(consumed, {});
  assert.deepEqual(renderedHints(s), []);
});
