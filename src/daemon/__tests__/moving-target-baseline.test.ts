import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  markDeferredInteractionOutcome,
  movingTargetBaseline,
  retireMovingTargetBaseline,
} from '../deferred-interaction-outcome.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { SessionState } from '../session-state.ts';
import { makeSession } from './post-gesture-stabilization-fixtures.ts';

// #3471, the `recheck` half of the session's deferred surface: what a finished mutation is allowed
// to record about where things were. Everything here is about refusing to record — the gate's whole
// cost contract rests on a session with no trustworthy history reading as idle rather than as a
// surface that just moved. The capture-side `stabilize` variant is the sibling cluster's subject
// (post-gesture-stabilization.test.ts).

function appTree(label = 'Slide target') {
  return makeSnapshotState([
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label,
      rect: { x: 10, y: 240, width: 120, height: 50 },
      hittable: true,
    },
  ]);
}

/** Marks a press (a non-gesture action) that resolved its target against `preActionTree`. */
function markPress(session: SessionState, preActionTree: SurfaceScopedNodes | undefined): void {
  markDeferredInteractionOutcome({
    session,
    command: 'press',
    positionals: ['label="Slide target"'],
    flags: undefined,
    preActionTree,
  });
}

test('a mutation that resolved a target records its tree at the instant it finished', () => {
  const session = makeSession('android');
  const preAction = appTree();

  markPress(session, { nodes: preAction.nodes });

  const baseline = movingTargetBaseline(session);
  assert.ok(baseline);
  assert.equal(baseline.tree.nodes, preAction.nodes);
  assert.ok(
    baseline.finishedAt >= Date.now() - 1_000 && baseline.finishedAt <= Date.now(),
    'the clock is the mutation END: the gate waits out what is LEFT of the window',
  );
});

test('a mutation that resolved no tree leaves the session idle', () => {
  const session = makeSession('android');
  session.snapshot = appTree();

  // The routes that dispatch without a daemon tree (a raw coordinate, a Maestro direct-selector tap,
  // `back`, an app open) must not invent one: substituting the stored snapshot would attribute to
  // this action a surface it never looked at, and make the next press pay a re-observation for it.
  markPress(session, undefined);

  assert.equal(movingTargetBaseline(session), undefined);
  assert.equal(session.deferredSurface, undefined);
});

test('an empty tree records nothing, because it would make every later target read as newly arrived', () => {
  const session = makeSession('android');

  markPress(session, { nodes: [] });

  assert.equal(movingTargetBaseline(session), undefined);
});

test('a baseline from an earlier action is replaced rather than kept beside the new one', () => {
  const session = makeSession('android');
  markPress(session, { nodes: appTree('First').nodes });
  const first = movingTargetBaseline(session);
  assert.ok(first);

  markPress(session, { nodes: appTree('Second').nodes });

  const second = movingTargetBaseline(session);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.notEqual(second.tree.nodes, first.tree.nodes);
});

test('a newer published observation beats the tree the action resolved against', () => {
  // The `--settle` and `--verify` case: the action published a tree AFTER its own resolution, and
  // that later capture is the better account of where the surface came to rest.
  const session = makeSession('android');
  const settled = appTree('Settled');
  session.snapshot = settled;

  markPress(session, { nodes: appTree('Pre-action').nodes });

  assert.equal(movingTargetBaseline(session)?.tree.nodes, settled.nodes);
});

test('the observation an action resolved against is kept when it is also the newest one', () => {
  // Identity, not content, decides: `surfaceScopedNodes` keeps the capture's own array, so a session
  // holding that same array has published nothing newer than the action's own resolution.
  const session = makeSession('android');
  const resolved = appTree();
  session.snapshot = resolved;

  markPress(session, { nodes: resolved.nodes });

  assert.equal(movingTargetBaseline(session)?.tree.nodes, resolved.nodes);
});

test('a baseline keeps the surface its tree came from', () => {
  // #2438: an iOS system-sheet tree must never be screened against app content, so the scoping the
  // capture carried has to survive into the value the gate reads.
  const session = makeSession('ios');
  const sheet = makeSnapshotState(
    [{ index: 0, type: 'Button', label: 'Allow', rect: { x: 10, y: 20, width: 80, height: 40 } }],
    { iosSystemSurfaceBundleId: 'com.apple.springboard' },
  );
  session.snapshot = sheet;

  // The scope rides through as-is: the capture side narrows its tree with the same shape
  // (`surfaceScopedNodes`), so an iOS system-sheet tree must never be screened against app content.
  markPress(session, { nodes: sheet.nodes, surfaceBundleId: 'com.apple.springboard' });

  assert.equal(movingTargetBaseline(session)?.tree.surfaceBundleId, 'com.apple.springboard');
});

test('a device side effect the session did not resolve a target through retires the baseline', () => {
  // ADR 0014's seam: the tree on hand now predates a change nobody measured, so screening a later
  // press against it would be positional coincidence rather than evidence. A gate out of evidence
  // goes idle instead of reconstructing a baseline from another source.
  const session = makeSession('android');
  markPress(session, { nodes: appTree().nodes });

  expireRefFrame(session);

  assert.equal(movingTargetBaseline(session), undefined);
});

test('retiring is idempotent and leaves no stale window behind', () => {
  const session = makeSession('android');
  markPress(session, { nodes: appTree().nodes });

  retireMovingTargetBaseline(session);
  retireMovingTargetBaseline(session);

  assert.equal(session.deferredSurface, undefined);
});

test('retiring never touches a pending capture-side stabilization', () => {
  // The seam fires on the way INTO every device op, including the gesture that just marked a
  // stabilization. Clearing both variants there would silently drop the quiet-window loop the
  // gesture is owed — a scroll would read the tree mid-flight again.
  const session = makeSession('ios');
  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
    preActionTree: { nodes: appTree().nodes },
  });

  expireRefFrame(session);

  assert.equal(session.deferredSurface?.kind, 'stabilize');
  assert.equal(movingTargetBaseline(session), undefined);
});

test('a press never erases a stabilization the capture side is still owed', () => {
  // A `@ref` press resolves against its authorized frame and spends no capture, so a scroll's owed
  // quiet-window loop is STILL pending when this press finishes (#1542/#1600). Overwriting it with a
  // baseline would hand the next capture a plain read and drop the unsettled-tree check the scroll
  // paid for. A selector press discharges the loop with its own resolution capture before reaching
  // here, so this guard only ever protects the owed case.
  const session = makeSession('ios');
  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
    preActionTree: { nodes: appTree().nodes },
  });

  markPress(session, { nodes: appTree('Other').nodes });

  assert.equal(session.deferredSurface?.kind, 'stabilize');
  assert.equal(movingTargetBaseline(session), undefined);
});

test('a gesture takes the surface over from a press, rather than joining it', () => {
  // One field, one mechanism per mutation: a press that left the surface mid-animation followed by
  // a scroll hands that surface to the capture side, which is the stronger of the two waits.
  const session = makeSession('android');
  markPress(session, { nodes: appTree().nodes });

  markDeferredInteractionOutcome({
    session,
    command: 'scroll',
    positionals: ['down'],
    flags: undefined,
    preActionTree: { nodes: appTree().nodes },
  });

  assert.equal(session.deferredSurface?.kind, 'stabilize');
  assert.equal(movingTargetBaseline(session), undefined);
});

test('an ineligible action marks nothing at all, leaving the record untouched', () => {
  // Eligibility stays per marker: `type` is neither gesture-shaped nor given a resolved tree here,
  // so a session that was idle stays idle rather than owing every later press a re-observation.
  const session = makeSession('android');

  markDeferredInteractionOutcome({
    session,
    command: 'type',
    positionals: ['hello'],
    flags: undefined,
  });

  assert.equal(session.deferredSurface, undefined);
});
