import assert from 'node:assert/strict';

import { SNAPSHOT_QUALITY_STATES } from '@agent-device/kernel/snapshot';

import {
  assertWaitText,
  type LiveSnapshotNode as SnapshotNode,
  snapshotNodes,
} from './live-assertions.ts';
import { waitForDeepLinkDestination } from './live-deep-link-destination.ts';
import { type LiveContext, runStep, verifyBehavior } from './live-harness.ts';

const VISIBLE_DEPTH_DEEP_LINK = 'agent-device-test-app:///snapshot-depth';
const CHILD_ID = 'visible-depth-projected-child';
const MISSING_HITTABILITY_WARNING =
  'iOS snapshot acquisition does not provide hittability evidence; regular snapshots omit unverified hittability while raw snapshots preserve supplied facts.';

export async function assertRegularVisibleDepthFrontier(context: LiveContext): Promise<void> {
  await runStep(context, 'open regular visible-depth fixture', [
    'open',
    context.appId,
    '--relaunch',
    '--launch-url',
    VISIBLE_DEPTH_DEEP_LINK,
    '--debug',
  ]);
  // Wait for the target itself so the depth assertion is about the frontier, not route readiness.
  await waitForDeepLinkDestination(context, [`id="${CHILD_ID}"`], { debug: true });

  const regular = await runStep(context, 'capture regular visible-depth frontier', [
    'snapshot',
    '--depth',
    '1',
    '--debug',
  ]);
  assertSimulatorSnapshotAcquisition(regular, 'regular depth-1 snapshot');
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
  assert.equal(
    projectedChild.hittable,
    true,
    `on-screen projected child should carry geometric hittability: ${JSON.stringify(regular)}`,
  );
  assert.ok(
    regularNodes.every((node) => numericDepth(node) <= 1),
    `regular --depth 1 exceeded the presented frontier: ${JSON.stringify(regular)}`,
  );

  const rawFull = await runStep(context, 'capture full raw visible-depth tree', [
    'snapshot',
    '--raw',
  ]);
  assertSimulatorSnapshotAcquisition(rawFull, 'full raw visible-depth snapshot');
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
  assertSimulatorSnapshotAcquisition(rawDepthOne, 'raw depth-1 visible-depth snapshot');
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

/**
 * Reason codes that name a PRE-SELECTED backend rather than a capture that degraded
 * (`deferred`: the runner's penalty circuit; `requested-backend`: the caller asked for that
 * strategy). They are the two codes the product's own quality-warning renderer exempts from any
 * degradation sentence for the same reason: nothing on THIS capture went wrong.
 */
const PRE_SELECTED_REASON_CODES: ReadonlySet<unknown> = new Set(['deferred', 'requested-backend']);

/**
 * The acquisition disclosure this scenario accepts before reading depth facts off the capture,
 * keyed on the typed `snapshotQuality` verdict and never on the fallback warning's wording.
 *
 * A regular or raw capture of the fixture is served one of two ways, and each discloses itself
 * here (#3328):
 *
 * - the host AX bridge served it. The bridge publishes no quality verdict at all
 *   (`presentIosSnapshotAcquisition` reports the tree it read without one), so an absent verdict IS
 *   the bridge's disclosure.
 * - the route sent the capture to the XCTest runner instead — the bridge probe circuit is open for
 *   this app generation, the bridge is still being prepared, a system surface is presented — and
 *   the runner always stamps which of its own strategies served the payload. That disclosure is
 *   legitimate on a regular snapshot: the bridge is a fast path, its circuit is per app generation,
 *   and a runner-served capture keeps the hittability evidence this scenario asserts below.
 *
 * What the scenario may NOT be read from is a capture whose own verdict says it degraded or
 * served nothing: `sparse` means no backend served the screen, and `recovered` with a code other
 * than the two pre-selected ones means the strategy the presented depth semantics belong to failed
 * mid-capture and another answered (#1569 — two strategies are not comparable views of one screen).
 * Either one fails here with the response that proved it. A verdict whose state is outside the
 * kernel-declared `SNAPSHOT_QUALITY_STATES` exhausts nothing and fails too — the lane must not
 * certify a tree whose acquisition it does not classify.
 */
export function assertSimulatorSnapshotAcquisition(
  result: { json?: any },
  description: string,
): void {
  const quality = result.json?.data?.snapshotQuality;
  if (quality !== undefined) {
    assert.ok(
      (SNAPSHOT_QUALITY_STATES as readonly unknown[]).includes(quality.state),
      `${description} disclosed a quality state outside the declared vocabulary: ${JSON.stringify(result)}`,
    );
    assert.notEqual(
      quality.state,
      'sparse',
      `${description} reports no backend served this screen: ${JSON.stringify(result)}`,
    );
    if (quality.state === 'recovered') {
      assert.ok(
        PRE_SELECTED_REASON_CODES.has(quality.reasonCode),
        `${description} fell back to another capture strategy mid-capture, so its presented depth is not comparable: ${JSON.stringify(result)}`,
      );
    }
  }
  assert.equal(
    result.json?.data?.warnings?.includes(MISSING_HITTABILITY_WARNING) ?? false,
    false,
    `${description} reported a viewport, so the AX bridge must derive hittability instead of disclosing it as missing: ${JSON.stringify(result)}`,
  );
}
