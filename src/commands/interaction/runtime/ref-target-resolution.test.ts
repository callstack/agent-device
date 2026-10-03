import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref } from './selector-read-utils.ts';
import { tryResolveRefNode } from './ref-target-resolution.ts';
import { STALE_REF_HINT } from '@agent-device/selectors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import type { Point } from '@agent-device/kernel/snapshot';
import { createInteractionDevice, selectorSnapshot } from './__tests__/test-utils/index.ts';

test('runtime ref interactions fail closed when the authorized ref has no usable bounds (ADR 0014)', async () => {
  const staleSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      hittable: true,
    },
  ]);
  const calls: Point[] = [];
  let captures = 0;
  const device = createInteractionDevice(staleSnapshot, {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: selectorSnapshot() };
    },
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  // ADR 0014: the authorized frame's @e1 has no usable rect, so it FAILS rather
  // than recapturing and accepting the same index from a newer tree by
  // positional coincidence.
  await assert.rejects(
    () => device.interactions.click(ref('@e1'), { session: 'default' }),
    (error: unknown) => {
      assert.match((error as Error).message, /Ref @e1 has no usable bounds/);
      assert.deepEqual(
        (error as { details?: Record<string, unknown> }).details,
        { reason: 'target_bounds_invalid', ref: 'e1', hint: STALE_REF_HINT, dispatched: 'no' },
        'the frame lists @e1, so the refusal names the bounds, not a missing ref',
      );
      return true;
    },
  );
  assert.equal(captures, 0);
  assert.deepEqual(calls, []);
});

test('runtime ref interactions refuse a ref the authorized frame does not list with ref_not_found', async () => {
  const calls: Point[] = [];
  let captures = 0;
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: selectorSnapshot() };
    },
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e9'), { session: 'default' }),
    (error: unknown) => {
      assert.match((error as Error).message, /Ref @e9 not found/);
      assert.deepEqual((error as { details?: Record<string, unknown> }).details, {
        reason: 'ref_not_found',
        ref: 'e9',
        hint: STALE_REF_HINT,
        dispatched: 'no',
      });
      return true;
    },
  );
  assert.equal(captures, 0);
  assert.deepEqual(calls, []);
});

test('tryResolveRefNode discloses exact for a resolved ref and label-fallback for label recovery', () => {
  const nodes = selectorSnapshot().nodes;

  const exact = tryResolveRefNode(nodes, '@e1', { fallbackLabel: '' });
  assert.equal(exact.kind, 'resolved');
  if (exact.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(exact.resolved.node.label, 'Continue');
  assert.deepEqual(exact.resolved.resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'exact',
  });

  const recovered = tryResolveRefNode(nodes, '@e9', { fallbackLabel: 'Continue' });
  assert.equal(recovered.kind, 'resolved');
  if (recovered.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(recovered.resolved.node.label, 'Continue');
  assert.deepEqual(recovered.resolved.resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'label-fallback',
  });

  assert.deepEqual(tryResolveRefNode(nodes, '@e9', { fallbackLabel: '' }), { kind: 'missing' });
});

test('tryResolveRefNode tells a listed node without a usable centre from a missing one', () => {
  const unusable = makeSnapshotState([
    { index: 0, depth: 0, type: 'Button', label: 'Continue', hittable: true },
  ]).nodes;

  const byRef = tryResolveRefNode(unusable, '@e1', { fallbackLabel: '' });
  assert.equal(byRef.kind, 'unusable');
  if (byRef.kind !== 'unusable') throw new Error('unreachable');
  assert.equal(byRef.node.label, 'Continue');

  const byLabel = tryResolveRefNode(unusable, '@e9', { fallbackLabel: 'Continue' });
  assert.equal(
    byLabel.kind,
    'unusable',
    'the trailing-label recovery found the node, so it is not missing',
  );

  assert.deepEqual(tryResolveRefNode(unusable, '@e9', { fallbackLabel: 'Elsewhere' }), {
    kind: 'missing',
  });
});
