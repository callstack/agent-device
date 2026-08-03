import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import {
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
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

// ---------------------------------------------------------------------------
// classifyBaselineSurfaceEvidence (#1542 defect 2, #1563 review): subset-
// tolerant, three-valued baseline comparison. Live evidence on
// checkout-form.ad showed the pre-gesture baseline (captured by an earlier
// `wait`, a broad query) and the post-gesture quiet signature (captured by
// the click's interactive-only selector resolution) never line up as whole
// arrays even when the target element never moved — the first version of
// this check has to see through that scope drift.
//
// The #1563 review then caught a SECOND failure mode in that first version
// (a plain "any shared entry frozen" boolean): the viewport root
// (Application/Window) is always present and its rect is invariant under any
// gesture, so a broad baseline and a narrow post-gesture capture can share
// ONLY the root even after a real, successful scroll — and the boolean
// predicate called that a match. `classifyBaselineSurfaceEvidence` requires
// at least one DISCRIMINATING shared entry (excluding the viewport root and
// keyboard chrome) before calling it `'unchanged'`; a root-only (or
// no-discriminating-evidence) overlap is `'ambiguous'` instead.
// ---------------------------------------------------------------------------

test('classifyBaselineSurfaceEvidence reports unchanged for identical signatures', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'unchanged');
});

test('classifyBaselineSurfaceEvidence is ambiguous when either side is empty', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox').nodes);

  assert.equal(classifyBaselineSurfaceEvidence([], baseline), 'ambiguous');
  assert.equal(classifyBaselineSurfaceEvidence(baseline, []), 'ambiguous');
  assert.equal(classifyBaselineSurfaceEvidence([], []), 'ambiguous');
});

test('classifyBaselineSurfaceEvidence reports unchanged through a broader baseline scope when the shared discriminating element is frozen', () => {
  // The exact live shape: the baseline came from a broader capture (extra
  // "Loading" text node the interactive-only capture never sees), but the
  // shared "primary-action" button never moved.
  const baseline = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500).nodes);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'unchanged');
});

test('classifyBaselineSurfaceEvidence reports unchanged through a broader current scope when the shared discriminating element is frozen', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'unchanged');
});

test('classifyBaselineSurfaceEvidence detects real movement even through a scope difference', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 120).nodes);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'changed');
});

test('classifyBaselineSurfaceEvidence is ambiguous when the signatures share no key at all', () => {
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

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'ambiguous');
});

test('classifyBaselineSurfaceEvidence tolerates tiny rect drift on the shared discriminating element', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshotWithExtraText('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500.4).nodes);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'unchanged');
});

// --- #1563 review regression: root-only overlap must NOT read as evidence ---

test('classifyBaselineSurfaceEvidence is ambiguous (NOT unchanged) when a real scroll leaves only the application root shared — the reviewer-caught false-distrust shape', () => {
  // baseline = {Application, Pickup@y=500}; current = {Application,
  // OtherButton@...} — a genuine, successful scroll replaced every real
  // element in view, so the only entry the two signatures still share is the
  // always-present, always-identical viewport root. A boolean "any shared
  // entry frozen" predicate calls this a baseline match (the root always
  // "matches") and would extend the interaction to the 3.5s stale-read
  // deadline on zero real evidence — exactly the bug this test pins.
  const baseline = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y: 500, width: 200, height: 44 },
    },
  ]);
  const current = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-delivery',
      label: 'Delivery',
      rect: { x: 20, y: 120, width: 200, height: 44 },
    },
  ]);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'ambiguous');
});

test('classifyBaselineSurfaceEvidence is ambiguous when the current capture is the application root alone', () => {
  const baseline = buildInteractionSurfaceSignature(makeSnapshot('Inbox', 500).nodes);
  const current = buildInteractionSurfaceSignature([applicationRootNode()]);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'ambiguous');
});

test('classifyBaselineSurfaceEvidence excludes the keyboard container from discriminating overlap', () => {
  const keyboardNode = {
    ref: 'e3',
    index: 2,
    parentIndex: 0,
    type: 'Keyboard',
    rect: { x: 0, y: 500, width: 390, height: 300 },
  };
  const baseline = buildInteractionSurfaceSignature([applicationRootNode(), keyboardNode]);
  // The keyboard's own container rect never changes; only the app content
  // does. A capture sharing just the root and the keyboard container (no
  // real content) must not read as a baseline match.
  const current = buildInteractionSurfaceSignature([applicationRootNode(), keyboardNode]);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'ambiguous');
});

// #1563 review, finding 2: a container-only exclusion still misses keyboard
// DESCENDANTS (individual keys) and SIBLINGS (assistant buttons like "Next
// keyboard"/"Dictate", which live outside the container per
// src/core/snapshot-chrome.ts's collectKeyboardChrome doc comment — a
// container-descendant walk alone provably misses them, hence the whole-
// window classification that module reuses here via collectKeyboardChromeRefs).
test('classifyBaselineSurfaceEvidence excludes keyboard DESCENDANTS and window SIBLINGS, not just the container, from discriminating overlap', () => {
  const shared = keyboardWindowNodes(); // window + [Keyboard] container + a key + a sibling "Next keyboard" button
  const baseline = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e-pickup',
      index: 20,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-pickup',
      label: 'Pickup',
      rect: { x: 20, y: 500, width: 200, height: 44 },
    },
    ...shared,
  ]);
  // Real content changed (Pickup -> Delivery, a genuine successful scroll);
  // the keyboard subtree is identical — a keyboard does not move when app
  // content scrolls.
  const current = buildInteractionSurfaceSignature([
    applicationRootNode(),
    {
      ref: 'e-delivery',
      index: 20,
      parentIndex: 0,
      type: 'Button',
      identifier: 'shipping-delivery',
      label: 'Delivery',
      rect: { x: 20, y: 120, width: 200, height: 44 },
    },
    ...shared,
  ]);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'ambiguous');
});

/**
 * A keyboard-window subtree: a `[Keyboard]` container plus a SIBLING "Next
 * keyboard" assistant button under the same window — matches the shape in
 * `src/daemon/__tests__/post-gesture-stabilization-fixtures.ts`'s
 * `keyboardWindowNodes` (kept local here rather than imported: this file's
 * fixtures are raw node literals consumed directly by
 * `buildInteractionSurfaceSignature`, not `SnapshotState`-wrapped like that
 * module's).
 */
function keyboardWindowNodes() {
  return [
    {
      ref: 'e-kb-window',
      index: 10,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 400, width: 390, height: 444 },
    },
    {
      ref: 'e-kb-container',
      index: 11,
      parentIndex: 10,
      type: 'Keyboard',
      rect: { x: 0, y: 500, width: 390, height: 300 },
    },
    {
      ref: 'e-kb-key-a',
      index: 12,
      parentIndex: 11, // descendant of the container
      type: 'Key',
      label: 'A',
      rect: { x: 10, y: 520, width: 30, height: 40 },
    },
    {
      ref: 'e-kb-next',
      index: 13,
      parentIndex: 10, // sibling of the container, NOT a descendant
      type: 'Button',
      label: 'Next keyboard',
      rect: { x: 340, y: 520, width: 40, height: 40 },
    },
  ];
}

test('classifyBaselineSurfaceEvidence still reports unchanged when the root AND a real discriminating element both match (guards against over-excluding)', () => {
  // Root-sharing alone is not disqualifying — it just cannot be the ONLY
  // evidence. Once a real, frozen discriminating element is also shared
  // (the ordinary "genuinely stuck" case), the verdict must still be
  // 'unchanged', not swing to 'ambiguous' just because the root is present.
  const snapshotNodes = makeSnapshot('Inbox', 500).nodes; // [Application, primary-action Button]
  const baseline = buildInteractionSurfaceSignature(snapshotNodes);
  const current = buildInteractionSurfaceSignature(snapshotNodes);

  assert.equal(classifyBaselineSurfaceEvidence(baseline, current), 'unchanged');
});

function applicationRootNode() {
  return {
    ref: 'e1',
    index: 0,
    type: 'Application',
    label: 'App',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  };
}

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
