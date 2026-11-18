import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { presentAppleRunnerSnapshot } from './snapshot-presentation.ts';

// The Apple runner compiles its fold policy per runtime and never states it on the wire
// (#4654). The host revalidates that runner payload and must read the same rule from the same Apple
// OS leaf, so `runnerFoldPolicy` in `snapshot-presentation.ts` and `platformDefault` in
// SnapshotVisibilityFold.swift are one fact in two languages. Nothing shares the two, so this guard
// reads the Swift branch from source and drives every Apple leaf through the host seam.

const SWIFT_FOLD = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'apple',
  'snapshot-presentation',
  'Sources',
  'AgentDeviceSnapshotPresentation',
  'SnapshotVisibilityFold.swift',
);

const SWIFT_POLICY =
  /public static var platformDefault: Self \{\s*#if os\(iOS\)\s*return \.(cursorProjected|plainViewport)\s*#else\s*return \.(cursorProjected|plainViewport)\s*#endif/;

/** A focused collection-view cell whose content the tvOS focus effect scaled past the row's frame. */
const FOCUS_SCALED_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 1920, height: 1080 }, depth: 0 },
  {
    index: 1,
    parentIndex: 0,
    type: 'CollectionView',
    rect: { x: 0, y: 210, width: 1920, height: 501 },
    depth: 1,
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'Cell',
    label: 'Focused tile',
    rect: { x: 87.6625, y: 197.475, width: 350.175, height: 526.05 },
    depth: 2,
    focused: true,
    hittable: true,
  },
];

const LEAVES: ReadonlyArray<Readonly<{ device: DeviceInfo; clipsToScrollContainers: boolean }>> = [
  { device: leaf('iPhone 17 Pro', 'ios'), clipsToScrollContainers: true },
  { device: leaf('iPad Pro', 'ipados'), clipsToScrollContainers: true },
  { device: leaf('Apple TV 4K', 'tvos', 'tv'), clipsToScrollContainers: false },
  { device: leaf('Apple Vision Pro', 'visionos'), clipsToScrollContainers: false },
];

function leaf(
  name: string,
  appleOs: DeviceInfo['appleOs'],
  target?: DeviceInfo['target'],
): DeviceInfo {
  return { platform: 'apple', id: `parity-${appleOs}`, name, kind: 'simulator', appleOs, target };
}

test("the runner's compile-time fold policy keeps the branch the host mirrors", () => {
  const branches = readSource(SWIFT_FOLD).match(SWIFT_POLICY);
  assert.ok(branches, 'platformDefault no longer matches the shape the host mirrors');
  assert.equal(
    branches[1],
    'cursorProjected',
    'the iOS runtime stopped using the projection cursor',
  );
  assert.equal(branches[2], 'plainViewport', 'the non-iOS runtimes stopped using plain viewport');
});

for (const { device, clipsToScrollContainers } of LEAVES) {
  test(`the host revalidates ${device.appleOs} with the fold policy its runner compiled`, () => {
    const present = () =>
      presentAppleRunnerSnapshot(device, undefined, {
        nodes: FOCUS_SCALED_NODES,
        viewportEvidence: { kind: 'reported', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      });

    if (clipsToScrollContainers) {
      assert.throws(
        present,
        (error: unknown) =>
          error instanceof Error &&
          (error as { details?: { reason?: string } }).details?.reason ===
            'regular-node-outside-cumulative-clip',
      );
      return;
    }
    assert.equal(present().nodes.find((node) => node.focused === true)?.hittable, true);
  });
}

function readSource(file: string): string {
  return fs.readFileSync(file, 'utf8');
}
