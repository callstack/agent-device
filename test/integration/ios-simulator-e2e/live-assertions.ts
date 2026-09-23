import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  assertFilesDiffer,
  assertJsonContains,
  assertMp4File,
  assertNonEmptyFile,
  createLiveDeviceAssertions,
} from '../live-device-e2e/assertions.ts';
import type { CliJsonResult } from '../cli-json.ts';
import type { IosSimulatorBehaviorId } from './behavior-coverage.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

export { assertFilesDiffer, assertJsonContains, assertMp4File, assertNonEmptyFile };

export const { assertElementText, assertWaitSelector, assertWaitText, capturePng } =
  createLiveDeviceAssertions<IosSimulatorBehaviorId, LiveContext>(
    runStep,
    verifyCommand,
    PUBLIC_COMMANDS.wait,
  );

export type LiveSnapshotNode = {
  depth?: unknown;
  hittable?: unknown;
  identifier?: unknown;
  index?: unknown;
  label?: unknown;
  parentIndex?: unknown;
  type?: unknown;
};

export function snapshotNodes(result: { json?: any }): LiveSnapshotNode[] {
  const nodes = result.json?.data?.nodes;
  assert.ok(
    Array.isArray(nodes),
    `snapshot response did not contain nodes: ${JSON.stringify(result)}`,
  );
  return nodes as LiveSnapshotNode[];
}

const SCROLL_SEARCH_ATTEMPTS = 4;
// A stalled capture, or one taken while the last scroll was still moving, says nothing about where
// the element is, so re-reading it must not consume a scroll. A couple of re-reads per scroll absorb
// a slow runner without masking a real absence.
const SCROLL_SEARCH_REREADS = 2;

export async function assertElementTextAfterScrolling(
  context: LiveContext,
  selector: string,
  expected: string,
): Promise<void> {
  await searchForVisibleElement(
    selector,
    (attempt) =>
      runStep(
        context,
        `check ${selector} visibility after scroll (attempt ${attempt})`,
        ['is', 'visible', selector],
        { allowFailure: true },
      ),
    (attempt) =>
      runStep(context, `scroll toward ${selector} after attempt ${attempt}`, [
        'scroll',
        'down',
        '0.75',
      ]).then((result) => result.json?.data),
  );
  await assertElementText(context, selector, expected);
}

/**
 * Searches by semantic visibility rather than selector existence. An offscreen node can exist in
 * the accessibility tree, so a successful `wait <selector>` is not sufficient evidence to skip
 * scrolling. The callbacks keep this live-device policy deterministic and unit-testable without a
 * simulator.
 */
export async function searchForVisibleElement(
  selector: string,
  probeVisibility: (attempt: number) => Promise<CliJsonResult>,
  scrollAfterAttempt: (attempt: number) => Promise<unknown>,
): Promise<void> {
  let rereadsLeft = SCROLL_SEARCH_REREADS;
  const history: string[] = [];

  for (let attempt = 1; attempt <= SCROLL_SEARCH_ATTEMPTS;) {
    const probe = await probeVisibility(attempt);
    history.push(`probe ${attempt}: ${JSON.stringify(probe.json ?? { status: probe.status })}`);
    if (probe.status === 0) return;

    const details = probe.json?.error?.details;
    const readNothing = details?.captureStalled === true || details?.unsettledGesture !== undefined;
    if (readNothing && rereadsLeft > 0) {
      rereadsLeft -= 1;
      continue;
    }

    attempt += 1;
    if (attempt <= SCROLL_SEARCH_ATTEMPTS) {
      const scrolled = await scrollAfterAttempt(attempt - 1);
      history.push(`scroll after attempt ${attempt - 1}: ${JSON.stringify(scrolled ?? null)}`);
      rereadsLeft = SCROLL_SEARCH_REREADS;
    }
  }
  assert.fail(`${selector} did not become visible after scrolling\n${history.join('\n')}`);
}

function requireNode(
  result: CliJsonResult,
  identifier: string,
): { label?: unknown; rect?: { height: number; width: number; x: number; y: number } } {
  const nodes = Array.isArray(result.json?.data?.nodes) ? result.json.data.nodes : [];
  const node = nodes.find(
    (candidate: { identifier?: unknown }) => candidate.identifier === identifier,
  );
  assert.ok(node, `snapshot missing ${identifier}: ${JSON.stringify(result.json)}`);
  return node;
}

export function requireNodeRect(
  result: CliJsonResult,
  identifier: string,
): { height: number; width: number; x: number; y: number } {
  const rect = requireNode(result, identifier).rect;
  assert.ok(rect, `snapshot node ${identifier} has no rect: ${JSON.stringify(result.json)}`);
  for (const value of [rect.x, rect.y, rect.width, rect.height]) {
    assert.ok(Number.isFinite(value), `snapshot node ${identifier} has invalid rect`);
  }
  return rect;
}

export function requireDevice(result: CliJsonResult, udid: string): { booted?: unknown } {
  const devices = Array.isArray(result.json?.data?.devices) ? result.json.data.devices : [];
  const device = devices.find((candidate: { id?: unknown }) => candidate.id === udid);
  assert.ok(device, `device inventory missing ${udid}: ${JSON.stringify(result.json)}`);
  return device;
}
