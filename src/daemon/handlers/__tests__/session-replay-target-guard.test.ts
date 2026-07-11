// Split-resolver guard (coordinator addition to step 4): dispatch resolution
// runs occlusion/visibility guards verification does not replicate, so its
// winner can differ from the verified member. The post-resolution guard
// (`expectedResolvedTarget` -> `assertExpectedResolvedTarget`) must refuse
// PRE-ACTION in that case instead of tapping a different element.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';
import {
  readNodeLocalIdentity,
  readNodeStructuralDenotation,
  type ReplayTargetGuardDenotation,
} from '../../../replay/target-identity-node.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { ref as interactionRef, selector } from '../../../commands/index.ts';
import { createInteractionDevice } from '../../../commands/interaction/runtime/__tests__/test-utils/index.ts';
import { classifyReplayTarget } from '../session-replay-target-classification.ts';

/** The verified-member guard denotation the replay loop mints (identity + structural position). */
function guardFor(node: SnapshotNode, nodes: SnapshotNode[]): ReplayTargetGuardDenotation {
  return {
    identity: readNodeLocalIdentity(node),
    structural: readNodeStructuralDenotation(node, nodes),
  };
}

function assertVerified(
  result: ReturnType<typeof classifyReplayTarget>,
  expected: { winnerRef: string; matchCount: number },
): void {
  assert.equal(result.verified, true);
  if (!result.verified) throw new Error('unreachable');
  assert.equal(result.winnerNode.ref, expected.winnerRef);
  assert.equal(result.matchCount, expected.matchCount);
}

// ---------------------------------------------------------------------------

/**
 * The split fixture: two "Save" buttons. A (deeper) wins verification's
 * unfiltered disambiguation, but dispatch filters it out as covered and
 * resolves B instead — verified-but-would-tap-a-different-node.
 */
function splitResolverSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      // A: the verified target — deeper (wins deepest-first disambiguation
      // over the UNFILTERED domain) but covered, so dispatch's
      // interactableSelectorNodes filter removes it.
      index: 1,
      depth: 3,
      parentIndex: 0,
      type: 'Button',
      identifier: 'save-a',
      label: 'Save',
      rect: { x: 16, y: 120, width: 140, height: 44 },
      interactionBlocked: 'covered',
    },
    {
      // B: visible sibling with the same label but a different identity —
      // dispatch's winner after A is filtered.
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'save-b',
      label: 'Save',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: true,
    },
  ]);
}

test('split resolver: verification verifies the covered deeper node while dispatch would resolve its visible sibling', () => {
  const nodes = splitResolverSnapshot().nodes;
  const nodeA = nodes.find((node) => node.identifier === 'save-a');
  assert.ok(nodeA);
  const recorded: TargetAnnotationV1 = {
    id: 'save-a',
    role: 'button',
    label: 'Save',
    ancestry: [{ role: 'application', label: 'Example' }],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  };
  const result = classifyReplayTarget({
    recorded,
    token: 'label="Save"',
    nodes,
    platform: 'ios',
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  // Verification's unfiltered domain: both buttons match; the identity set
  // isolates A; the unfiltered disambiguation winner is also A (deepest) —
  // path 4 verified. Dispatch would resolve B: exactly the split the
  // post-resolution guard exists to catch.
  assertVerified(result, { winnerRef: nodeA.ref, matchCount: 2 });
});

test('split resolver: the post-resolution guard refuses pre-action when dispatch resolves a different element', async () => {
  const snapshot = splitResolverSnapshot();
  const nodeA = snapshot.nodes.find((node) => node.identifier === 'save-a');
  assert.ok(nodeA);
  const taps: unknown[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  });

  await assert.rejects(
    device.interactions.press(selector('label="Save"'), {
      session: 'default',
      expectedResolvedTarget: guardFor(nodeA, snapshot.nodes),
    }),
    (error: unknown) => {
      const appError = error as {
        code?: string;
        details?: { reason?: string; observed?: { id?: string }; expected?: { id?: string } };
      };
      assert.equal(appError.code, 'COMMAND_FAILED');
      assert.equal(appError.details?.reason, 'replay_target_guard_mismatch');
      assert.equal(appError.details?.observed?.id, 'save-b');
      assert.equal(appError.details?.expected?.id, 'save-a');
      return true;
    },
  );
  // The refusal is pre-action: the tap never reached the backend.
  assert.deepEqual(taps, []);
});

test('split resolver: a matching identity passes the guard and the action proceeds', async () => {
  const snapshot = splitResolverSnapshot();
  const nodeB = snapshot.nodes.find((node) => node.identifier === 'save-b');
  assert.ok(nodeB);
  const taps: unknown[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  });

  const result = await device.interactions.press(selector('label="Save"'), {
    session: 'default',
    expectedResolvedTarget: guardFor(nodeB, snapshot.nodes),
  });
  assert.equal(result.kind, 'selector');
  assert.equal('node' in result ? result.node?.identifier : undefined, 'save-b');
  assert.equal(taps.length, 1);
  // A passing guard must retain the runtime resolution disclosure.
  assert.deepEqual('resolution' in result ? result.resolution : undefined, {
    source: 'runtime',
    phase: 'pre-action',
    kind: 'unique',
  });
});

test('split resolver: the guard forces the ref fast path onto the runtime resolution path', async () => {
  const snapshot = splitResolverSnapshot();
  const nodeB = snapshot.nodes.find((node) => node.identifier === 'save-b');
  assert.ok(nodeB);
  const taps: unknown[] = [];
  const tapTargets: unknown[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
    tapTarget: async (_context, target) => {
      tapTargets.push(target);
      return { ok: true };
    },
  });

  const result = await device.interactions.click(interactionRef(`@${nodeB.ref}`), {
    session: 'default',
    expectedResolvedTarget: guardFor(nodeB, snapshot.nodes),
  });
  // Without the guard, click @ref with a tapTarget backend takes the native
  // fast path (backend.tapTarget) and the guard would never run; with the
  // guard it must resolve through the runtime path (backend.tap).
  assert.deepEqual(tapTargets, []);
  assert.equal(taps.length, 1);
  // A guard-forced runtime ref resolution still discloses its exact source.
  assert.deepEqual('resolution' in result ? result.resolution : undefined, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'exact',
  });
});

// ---------------------------------------------------------------------------
// P1 regression: two SAME-local-identity duplicates ({id,role,label} all
// equal) at different structural positions. Verification denotes A (covered,
// deeper); dispatch's occlusion filter resolves B. A local-identity-only
// guard would pass (identical id/role/label) and tap the WRONG element — the
// exact verified-but-taps-different-node mis-binding step 4 exists to prevent.
// The structural denotation (document order + sibling) must catch the split.
// ---------------------------------------------------------------------------

/** Two "Save" buttons with IDENTICAL id/role/label; only structural position differs. */
function sameIdentityDuplicatesSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      // A: covered + deeper → verification's unfiltered disambiguation winner,
      // dropped by dispatch's occlusion filter. sibling 0, document order 1.
      index: 1,
      depth: 3,
      parentIndex: 0,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 16, y: 120, width: 140, height: 44 },
      interactionBlocked: 'covered',
    },
    {
      // B: visible → dispatch's winner. SAME id/role/label as A; sibling 1,
      // document order 2.
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: true,
    },
  ]);
}

test('same-identity duplicates: verification denotes the covered member A among two identical id/role/label buttons', () => {
  const nodes = sameIdentityDuplicatesSnapshot().nodes;
  const nodeA = nodes[1]!; // document order 1, covered
  const nodeB = nodes[2]!; // document order 2, visible
  // Sanity: A and B are genuinely indistinguishable by local identity.
  assert.deepEqual(readNodeLocalIdentity(nodeA), readNodeLocalIdentity(nodeB));
  const recorded: TargetAnnotationV1 = {
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [{ role: 'application', label: 'Example' }],
    sibling: 0, // isolates A among the two same-identity duplicates
    viewportOrder: 0,
    verification: 'verified',
  };
  const result = classifyReplayTarget({
    recorded,
    token: 'label="Save"',
    nodes,
    platform: 'ios',
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });
  // matchCount 2 (both match); path 6 sibling ordinal isolates A, which is
  // also the unfiltered disambiguation winner → verified on A.
  assertVerified(result, { winnerRef: nodeA.ref, matchCount: 2 });
});

test('same-identity duplicates: the structural guard refuses pre-action when dispatch resolves the OTHER duplicate (P1 regression)', async () => {
  const snapshot = sameIdentityDuplicatesSnapshot();
  const nodeA = snapshot.nodes[1]!;
  const taps: unknown[] = [];
  const tapTargets: unknown[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
    tapTarget: async (_context, target) => {
      tapTargets.push(target);
      return { ok: true };
    },
  });

  await assert.rejects(
    // Verification isolated A (document order 1); dispatch's occlusion filter
    // will resolve B (document order 2) — identical local identity.
    device.interactions.press(selector('label="Save"'), {
      session: 'default',
      expectedResolvedTarget: guardFor(nodeA, snapshot.nodes),
    }),
    (error: unknown) => {
      const appError = error as {
        code?: string;
        details?: {
          reason?: string;
          observed?: { id?: string };
          expected?: { id?: string };
          observedStructural?: { documentOrder?: number; sibling?: number };
          expectedStructural?: { documentOrder?: number; sibling?: number };
        };
      };
      assert.equal(appError.code, 'COMMAND_FAILED');
      assert.equal(appError.details?.reason, 'replay_target_guard_mismatch');
      // Local identity is IDENTICAL on both sides — the refusal is driven
      // purely by the structural denotation.
      assert.equal(appError.details?.observed?.id, 'save');
      assert.equal(appError.details?.expected?.id, 'save');
      assert.equal(appError.details?.expectedStructural?.documentOrder, 1);
      assert.equal(appError.details?.observedStructural?.documentOrder, 2);
      assert.equal(appError.details?.expectedStructural?.sibling, 0);
      assert.equal(appError.details?.observedStructural?.sibling, 1);
      return true;
    },
  );
  // Zero backend calls: neither the runtime tap nor the native fast path fired.
  assert.deepEqual(taps, []);
  assert.deepEqual(tapTargets, []);
});

test('same-identity duplicates: the guard passes when dispatch resolves the SAME structural member', async () => {
  // Remove A's `covered` flag so dispatch also resolves the deeper member A
  // (document order 1) that verification denoted — structural match, action proceeds.
  const snapshot = sameIdentityDuplicatesSnapshot();
  const nodeA = snapshot.nodes[1]!;
  delete nodeA.interactionBlocked;
  const taps: unknown[] = [];
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  });

  const result = await device.interactions.press(selector('label="Save"'), {
    session: 'default',
    expectedResolvedTarget: guardFor(nodeA, snapshot.nodes),
  });
  assert.equal(result.kind, 'selector');
  // Dispatch's deepest-first disambiguation also picks A (document order 1).
  assert.equal('node' in result ? result.node?.index : undefined, 1);
  assert.equal(taps.length, 1);
});
