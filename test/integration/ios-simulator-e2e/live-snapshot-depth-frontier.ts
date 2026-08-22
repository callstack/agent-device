import assert from 'node:assert/strict';

import { assertWaitSelector, assertWaitText } from './live-assertions.ts';
import { acceptDeepLinkConfirmationIfPresent } from './live-automation-scenario.ts';
import { type LiveContext, runStep, verifyBehavior } from './live-harness.ts';

const VISIBLE_DEPTH_DEEP_LINK = 'agent-device-test-app:///snapshot-depth';
const CHILD_ID = 'visible-depth-projected-child';

type SnapshotNode = {
  depth?: unknown;
  identifier?: unknown;
  index?: unknown;
  label?: unknown;
  parentIndex?: unknown;
};

export async function assertRegularVisibleDepthFrontier(context: LiveContext): Promise<void> {
  await runStep(context, 'open regular visible-depth fixture', [
    'open',
    context.appId,
    '--relaunch',
    '--launch-url',
    VISIBLE_DEPTH_DEEP_LINK,
  ]);
  await acceptDeepLinkConfirmationIfPresent(context);
  // Wait for the target itself so the depth assertion is about the frontier, not route readiness.
  await assertWaitSelector(context, `id="${CHILD_ID}"`);

  const regular = await runStep(context, 'capture regular visible-depth frontier', [
    'snapshot',
    '--depth',
    '1',
  ]);
  assertSnapshotBackend(regular, 'regular depth-1 snapshot');
  const regularNodes = snapshotNodes(regular);
  const regularRoot = requireRoot(regularNodes, 'regular depth-1 snapshot');
  const projectedChild = requireIdentifier(regularNodes, CHILD_ID, 'regular depth-1 snapshot');
  assert.equal(
    projectedChild.depth,
    1,
    `projected child should occupy presented depth 1: ${JSON.stringify(regular)}`,
  );
  assert.equal(
    projectedChild.parentIndex,
    regularRoot.index,
    `projected child should be reparented to the presented root: ${JSON.stringify(regular)}`,
  );
  assert.ok(
    regularNodes.every((node) => numericDepth(node) <= 1),
    `regular --depth 1 exceeded the presented frontier: ${JSON.stringify(regular)}`,
  );

  const rawFull = await runStep(context, 'capture full raw visible-depth tree', [
    'snapshot',
    '--raw',
  ]);
  assertSnapshotBackend(rawFull, 'full raw visible-depth snapshot');
  const rawFullNodes = snapshotNodes(rawFull);
  const rawChild = requireIdentifier(rawFullNodes, CHILD_ID, 'full raw visible-depth snapshot');
  assert.ok(
    numericDepth(rawChild) > 1,
    `raw projected child must remain below traversal depth 1: ${JSON.stringify(rawFull)}`,
  );

  const rawDepthOne = await runStep(context, 'capture raw depth-bounded visible-depth tree', [
    'snapshot',
    '--raw',
    '--depth',
    '1',
  ]);
  assertSnapshotBackend(rawDepthOne, 'raw depth-1 visible-depth snapshot');
  const rawDepthOneNodes = snapshotNodes(rawDepthOne);
  assert.equal(
    rawDepthOneNodes.some((node) => node.identifier === CHILD_ID),
    false,
    `raw --depth 1 must omit the raw depth-2 child: ${JSON.stringify(rawDepthOne)}`,
  );
  assert.ok(
    rawDepthOneNodes.every((node) => numericDepth(node) <= 1),
    `raw --depth 1 exceeded the acquisition frontier: ${JSON.stringify(rawDepthOne)}`,
  );

  await runStep(context, 'restore fixture home after visible-depth capture', [
    'open',
    context.appId,
    '--relaunch',
  ]);
  await assertWaitText(context, 'Agent Device Tester');
  verifyBehavior(
    context,
    'regular-visible-depth-frontier',
    'public regular depth 1 keeps a raw-deep visible child at presented depth 1 while raw depth remains traversal-bounded',
  );
}

function snapshotNodes(result: { json?: any }): SnapshotNode[] {
  const nodes = result.json?.data?.nodes;
  assert.ok(
    Array.isArray(nodes),
    `snapshot response did not contain nodes: ${JSON.stringify(result)}`,
  );
  return nodes as SnapshotNode[];
}

function requireIdentifier(nodes: SnapshotNode[], identifier: string, description: string) {
  const node = nodes.find((candidate) => candidate.identifier === identifier);
  assert.ok(node, `${description} missing ${identifier}: ${JSON.stringify(nodes)}`);
  return node;
}

function requireRoot(nodes: SnapshotNode[], description: string) {
  const root = nodes.find(
    (node) =>
      numericDepth(node) === 0 && (node.parentIndex === undefined || node.parentIndex === null),
  );
  assert.ok(root, `${description} missing a presented root: ${JSON.stringify(nodes)}`);
  return root;
}

function numericDepth(node: SnapshotNode): number {
  assert.equal(
    typeof node.depth,
    'number',
    `snapshot node has no numeric depth: ${JSON.stringify(node)}`,
  );
  return node.depth as number;
}

function assertSnapshotBackend(result: { json?: any }, description: string): void {
  assert.equal(
    result.json?.data?.snapshotQuality?.backend,
    'tree',
    `${description} must exercise the recursive tree backend: ${JSON.stringify(result)}`,
  );
}
