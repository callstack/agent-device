import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import {
  buildInteractionSurfaceSignature,
  classifyInteractionSurfaceChange,
  interactionSurfaceMatchesBaseline,
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

// ---------------------------------------------------------------------------
// interactionSurfaceMatchesBaseline (#1542 defect 2): subset-tolerant baseline
// comparison. Live evidence on checkout-form.ad showed the pre-gesture
// baseline (captured by an earlier `wait`, a broad query) and the post-gesture
// quiet signature (captured by the click's interactive-only selector
// resolution) never line up as whole arrays even when the target element
// never moved — this is the comparison that has to see through that scope
// drift.
// ---------------------------------------------------------------------------

test('interactionSurfaceMatchesBaseline matches identical signatures', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);

  assert.equal(interactionSurfaceMatchesBaseline(baseline, current), true);
});

test('interactionSurfaceMatchesBaseline treats an empty side as no evidence', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);

  assert.equal(interactionSurfaceMatchesBaseline([], baseline), false);
  assert.equal(interactionSurfaceMatchesBaseline(baseline, []), false);
  assert.equal(interactionSurfaceMatchesBaseline([], []), false);
});

test('interactionSurfaceMatchesBaseline matches through a broader baseline scope when the shared element is frozen', () => {
  // The exact live shape: the baseline came from a broader capture (extra
  // "Loading" text node the interactive-only capture never sees), but the
  // shared "primary-action" button never moved.
  const baseline = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500).nodes);

  assert.equal(interactionSurfaceMatchesBaseline(baseline, current), true);
});

test('interactionSurfaceMatchesBaseline matches through a broader current scope when the shared element is frozen', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);

  assert.equal(interactionSurfaceMatchesBaseline(baseline, current), true);
});

test('interactionSurfaceMatchesBaseline detects real movement even through a scope difference', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 120).nodes);

  assert.equal(interactionSurfaceMatchesBaseline(baseline, current), false);
});

test('interactionSurfaceMatchesBaseline is ambiguous (no match) when the signatures share no key', () => {
  const baseline = buildInteractionSurfaceSignature([
    {
      ref: 'e1',
      index: 0,
      type: 'Button',
      identifier: 'checkout-only-button',
      label: 'Checkout',
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
  ]);
  const current = buildInteractionSurfaceSignature([
    {
      ref: 'e1',
      index: 0,
      type: 'Button',
      identifier: 'settings-only-button',
      label: 'Settings',
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
  ]);

  assert.equal(interactionSurfaceMatchesBaseline(baseline, current), false);
});

test('interactionSurfaceMatchesBaseline tolerates tiny rect drift on the shared element', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500.4).nodes);

  assert.equal(interactionSurfaceMatchesBaseline(baseline, current), true);
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

// A broader-scope variant of makeSnapshot: the same Application + Button
// entries, plus a non-interactive text node an interactive-only capture would
// never return. Models the real shape mismatch between a pre-gesture baseline
// snapshot and a post-gesture interactive-only selector-resolution capture.
function makeSnapshotWithExtraText(label: string, y = 100): SnapshotState {
  const base = makeSnapshot(label, y);
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        ref: 'e3',
        index: 2,
        parentIndex: 0,
        type: 'Text',
        label: 'Loading',
        rect: { x: 20, y: 20, width: 200, height: 20 },
      },
    ],
  };
}
