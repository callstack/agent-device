import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildInteractionSurfaceSignature,
  classifyInteractionSurfaceChange,
  markPendingInteractionOutcome,
  stripInternalInteractionFlags,
} from '../interaction-outcome-policy.ts';
import type { SessionState } from '../types.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

test('classifyInteractionSurfaceChange treats identical surfaces as unchanged', () => {
  const before = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);
  const after = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);

  assert.equal(classifyInteractionSurfaceChange(before, after), 'unchanged');
});

test('classifyInteractionSurfaceChange tolerates tiny rect drift', () => {
  const before = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 100).nodes);
  const after = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 100.4).nodes);

  assert.equal(classifyInteractionSurfaceChange(before, after), 'unchanged');
});

test('classifyInteractionSurfaceChange detects semantic screen changes', () => {
  const before = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);
  const after = buildInteractionSurfaceSignature(makeSnapshot('Article detail').nodes);

  assert.equal(classifyInteractionSurfaceChange(before, after), 'changed');
});

test('classifyInteractionSurfaceChange detects material layout movement', () => {
  const before = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 100).nodes);
  const after = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 180).nodes);

  assert.equal(classifyInteractionSurfaceChange(before, after), 'changed');
});

test('markPendingInteractionOutcome stores retry state only for explicit retry flags', () => {
  const session = makeSession();
  markPendingInteractionOutcome({
    session,
    command: 'click',
    positionals: ['20', '40'],
    flags: {},
    preSnapshot: makeSnapshot('Inbox'),
  });
  assert.equal(session.pendingInteractionOutcome, undefined);

  const retrySession = makeSession();
  markPendingInteractionOutcome({
    session: retrySession,
    command: 'click',
    positionals: ['20', '40'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
    preSnapshot: makeSnapshot('Inbox'),
  });

  assert.equal(retrySession.pendingInteractionOutcome?.action, 'click');
  assert.equal(retrySession.pendingInteractionOutcome?.command, 'press');
  assert.equal(retrySession.pendingInteractionOutcome?.attemptsRemaining, 2);
  assert.equal(retrySession.pendingInteractionOutcome?.flags?.interactionOutcome, undefined);

  const refSession = makeSession();
  markPendingInteractionOutcome({
    session: refSession,
    command: 'click',
    positionals: ['@e1'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
    preSnapshot: makeSnapshot('Inbox'),
  });
  assert.equal(refSession.pendingInteractionOutcome, undefined);

  const longPressSession = makeSession();
  markPendingInteractionOutcome({
    session: longPressSession,
    command: 'longpress',
    positionals: ['20', '40', '800'],
    flags: { interactionOutcome: { retryOnNoChange: true } },
    preSnapshot: makeSnapshot('Inbox'),
  });
  assert.equal(longPressSession.pendingInteractionOutcome, undefined);
});

test('stripInternalInteractionFlags removes internal interaction controls', () => {
  assert.deepEqual(
    stripInternalInteractionFlags({
      platform: 'ios',
      interactionOutcome: { retryOnNoChange: true },
      postGestureStabilization: true,
    }),
    { platform: 'ios' },
  );
});

function makeSession(): SessionState {
  return {
    name: 'ios',
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}

function makeSnapshot(label: string, y = 100): SnapshotState {
  return {
    nodes: [
      {
        ref: 'e1',
        index: 0,
        type: 'Application',
        label: 'App',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        ref: 'e2',
        index: 1,
        parentIndex: 0,
        type: 'Button',
        identifier: 'primary-action',
        label,
        rect: { x: 120, y, width: 80, height: 40 },
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest',
  };
}
