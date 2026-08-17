import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
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

export const { assertElementText, assertWaitText, capturePng } = createLiveDeviceAssertions<
  IosSimulatorBehaviorId,
  LiveContext
>(runStep, verifyCommand, PUBLIC_COMMANDS.wait);

const SCROLL_SEARCH_ATTEMPTS = 4;
// A stalled capture says nothing about where the element is, so it must not consume the scroll
// budget outright; a couple of retries absorb a slow runner without masking a real absence.
const SCROLL_SEARCH_STALL_RETRIES = 2;

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
      ]).then(() => undefined),
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
  scrollAfterAttempt: (attempt: number) => Promise<void>,
): Promise<void> {
  let stallRetriesLeft = SCROLL_SEARCH_STALL_RETRIES;
  let lastFailure: CliJsonResult | undefined;

  for (let attempt = 1; attempt <= SCROLL_SEARCH_ATTEMPTS; ) {
    const probe = await probeVisibility(attempt);
    if (probe.status === 0) return;
    lastFailure = probe;

    // The snapshot never came back, so the surface was never read. Scrolling here would move the
    // surface for a reason unrelated to visibility and spend an attempt on no evidence.
    if (probe.json?.error?.details?.captureStalled === true && stallRetriesLeft > 0) {
      stallRetriesLeft -= 1;
      continue;
    }

    attempt += 1;
    if (attempt <= SCROLL_SEARCH_ATTEMPTS) {
      await scrollAfterAttempt(attempt - 1);
    }
  }
  assert.fail(
    `${selector} did not become visible after scrolling\nlast visibility probe: ${JSON.stringify(lastFailure?.json ?? null)}`,
  );
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
