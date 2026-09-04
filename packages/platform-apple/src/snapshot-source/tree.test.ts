import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeSnapshotBridgeTree } from './tree.ts';
import type { SnapshotSourceLimits } from './types.ts';

const limits: SnapshotSourceLimits = {
  maxRequestBytes: 1024,
  maxResponseBytes: 4096,
  maxNodes: 20,
  maxTraversalDepth: 10,
  maxDurationMs: 1000,
};

const application = 'XC_kAXXCAttributeElementType';
const baseType = 'XC_kAXXCAttributeElementBaseType';
const frame = 'XC_kAXXCAttributeFrame';
const children = 'XC_kAXXCAttributeChildren';
const label = 'XC_kAXXCAttributeLabel';
const automationType = 'XC_kAXXCAttributeAutomationType';

test('the bridge tree becomes one depth-first raw snapshot with viewport evidence', () => {
  const result = decodeSnapshotBridgeTree(
    {
      [application]: 'Application',
      [frame]: { X: 0, Y: 0, Width: 390, Height: 844 },
      [children]: [
        {
          [application]: 'Window',
          [baseType]: 'UIWindow',
          [frame]: { X: 0, Y: 0, Width: 390, Height: 844 },
          [children]: [
            {
              [automationType]: 9,
              [label]: 'Continue',
              [frame]: { X: 20, Y: 700, Width: 120, Height: 48 },
              [children]: [],
            },
          ],
        },
      ],
    },
    { truncated: false },
    limits,
  );

  assert.deepEqual(result.nodes, [
    {
      index: 0,
      type: 'Application',
      role: 'Application',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      depth: 0,
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'Window',
      role: 'Window',
      subrole: 'UIWindow',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      depth: 1,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Continue',
      rect: { x: 20, y: 700, width: 120, height: 48 },
      depth: 2,
    },
  ]);
  assert.deepEqual(result.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  });
  assert.equal(result.maxTraversalDepth, 2);
});

test('the bridge tree rejects unknown fields, invalid frames, and bounded overflows', () => {
  assert.throws(
    () => decodeSnapshotBridgeTree({ [children]: [], unknown: true }, { truncated: false }, limits),
    /node-contains-unknown-field/,
  );
  assert.throws(
    () =>
      decodeSnapshotBridgeTree(
        { [frame]: { X: 0, Y: 0, Width: -1, Height: 1 }, [children]: [] },
        { truncated: false },
        limits,
      ),
    /frame-invalid/,
  );
  assert.throws(
    () =>
      decodeSnapshotBridgeTree(
        {
          [children]: Array.from({ length: limits.maxNodes + 1 }, () => ({ [children]: [] })),
        },
        { truncated: false },
        limits,
      ),
    /node-limit-exceeded/,
  );
});

test('the bridge tree requires a typed truncation flag', () => {
  assert.throws(
    () => decodeSnapshotBridgeTree({ [children]: [] }, { truncated: 'yes' }, limits),
    /truncated-invalid/,
  );
});
