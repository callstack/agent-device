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

export async function assertElementTextAfterScrolling(
  context: LiveContext,
  selector: string,
  expected: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const visible = await runStep(
      context,
      `wait for ${selector} after scroll (attempt ${attempt})`,
      ['wait', selector, '1000'],
      { allowFailure: attempt < 4 },
    );
    if (visible.status === 0) {
      await assertElementText(context, selector, expected);
      return;
    }
    await runStep(context, `scroll toward ${selector}`, ['scroll', 'down', '0.75']);
  }
  assert.fail(`${selector} did not become visible after scrolling`);
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
