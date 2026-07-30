import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotDiffLine } from '../../../src/snapshot/snapshot-diff.ts';
import {
  assertFilesDiffer,
  assertJsonContains,
  createLiveDeviceAssertions,
} from '../live-device-e2e/assertions.ts';
import type { CliJsonResult } from '../cli-json.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

export { assertFilesDiffer, assertJsonContains };

export const { assertElementText, assertWaitSelector, assertWaitText, capturePng } =
  createLiveDeviceAssertions<AndroidEmulatorBehaviorId, LiveContext>(
    runStep,
    verifyCommand,
    PUBLIC_COMMANDS.wait,
  );

export function assertDiffLine(
  result: CliJsonResult,
  kind: SnapshotDiffLine['kind'],
  expectedText: string,
): void {
  const lines: unknown = result.json?.data?.lines;
  assert.ok(Array.isArray(lines), `snapshot diff has no lines: ${JSON.stringify(result.json)}`);
  assert.ok(
    lines.some(
      (line: unknown) =>
        isSnapshotDiffLine(line) && line.kind === kind && line.text.includes(expectedText),
    ),
    `expected ${kind} snapshot line containing ${expectedText}: ${JSON.stringify(result.json)}`,
  );
}

export function requireAndroidResourceId(
  result: CliJsonResult,
  suffix: string,
): {
  identifier: string;
  rect: { height: number; width: number; x: number; y: number };
} {
  const nodes: unknown = result.json?.data?.nodes;
  assert.ok(Array.isArray(nodes), `snapshot has no nodes: ${JSON.stringify(result.json)}`);
  const node = nodes.find(
    (candidate: unknown): candidate is RawSnapshotNode & { identifier: string } =>
      isSnapshotNode(candidate) &&
      typeof candidate.identifier === 'string' &&
      (candidate.identifier === suffix || candidate.identifier.endsWith(`:id/${suffix}`)),
  );
  assert.ok(
    node,
    `snapshot missing Android resource-id for ${suffix}: ${JSON.stringify(result.json)}`,
  );
  assert.ok(node.rect, `resource-id ${suffix} has no rect`);
  for (const value of [node.rect.x, node.rect.y, node.rect.width, node.rect.height]) {
    assert.ok(Number.isFinite(value), `resource-id ${suffix} has invalid rect`);
  }
  return { identifier: node.identifier, rect: node.rect };
}

export function assertPersistentAndroidHelper(
  result: CliJsonResult,
  options: { reused?: boolean } = {},
): void {
  const metadata: unknown = result.json?.data?.androidSnapshot;
  assert.ok(
    typeof metadata === 'object' && metadata !== null,
    `snapshot has no Android helper metadata: ${JSON.stringify(result.json)}`,
  );
  const helper = metadata as Record<string, unknown>;
  assert.equal(helper.backend, 'android-helper', JSON.stringify(metadata));
  assert.equal(helper.helperTransport, 'persistent-session', JSON.stringify(metadata));
  if (options.reused !== undefined) {
    assert.equal(helper.helperSessionReused, options.reused, JSON.stringify(metadata));
  }
}

function isSnapshotNode(value: unknown): value is RawSnapshotNode & { identifier: string } {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as RawSnapshotNode;
  return typeof node.identifier === 'string';
}

function isSnapshotDiffLine(value: unknown): value is SnapshotDiffLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Partial<SnapshotDiffLine>;
  return (
    (line.kind === 'added' || line.kind === 'removed' || line.kind === 'unchanged') &&
    typeof line.text === 'string'
  );
}
