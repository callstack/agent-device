import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PNG } from '@agent-device/capture-kit/png';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { createAgentDevice } from '../../../runtime.ts';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createInteractionDevice, selectorSnapshot } from './__tests__/test-utils/index.ts';

test('coordinate verification keeps a changed tree digest when the frames match', async () => {
  const { writeFile } = await import('node:fs/promises');
  let tapped = false;
  const device = createInteractionDevice(selectorSnapshot(), {
    // The tree digest moves (a navigation replaced the content) while the
    // pixels at the settle instant still match.
    captureSnapshot: async () => {
      if (!tapped) return { snapshot: selectorSnapshot() };
      return {
        snapshot: makeSnapshotState([
          {
            index: 0,
            depth: 0,
            type: 'Application',
            rect: { x: 0, y: 0, width: 400, height: 800 },
            hittable: true,
          },
        ]),
      };
    },
    tap: async () => {
      tapped = true;
    },
    clock: { now: () => 0, sleep: async () => {} },
    captureVerifyScreenshot: async (outPath) => {
      const png = new PNG({ width: 4, height: 4 });
      png.data.fill(255);
      await writeFile(outPath, PNG.sync.write(png));
      return { ignoreTopHeightShare: 0.25 };
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 200, y: 25 },
    { verify: true },
  );

  // Any comparison verification made saw a change: the digest answer survives
  // identical frames, and the pixel-only answer stays in screenshotDiff.
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.evidence?.screenshotDiff?.changedFromBefore, false);
});

test.each([
  { x: 15, verify: true, frames: [], changed: false },
  { x: 200, verify: false, frames: [], changed: undefined },
  { x: 200, verify: true, frames: ['before', 'after'], changed: false },
  { x: 200, verify: true, frames: ['before', 'after'], changed: true },
])(
  'coordinate verification brackets dispatch only away from a touch target ($x, $verify, $changed)',
  async ({ x, verify, frames, changed }) => {
    const { writeFile } = await import('node:fs/promises');
    const captures: string[] = [];
    let tapped = false;
    const device = createInteractionDevice(selectorSnapshot(), {
      tap: async () => {
        tapped = true;
      },
      clock: { now: () => 0, sleep: async () => {} },
      captureVerifyScreenshot: async (outPath) => {
        captures.push(tapped ? 'after' : 'before');
        const png = new PNG({ width: 4, height: 4 });
        png.data.fill(255);
        if (tapped) png.data[0] = 0; // Status-bar-only change is ignored.
        if (tapped && changed) png.data[16] = 0;
        await writeFile(outPath, PNG.sync.write(png));
        return { ignoreTopHeightShare: 0.25 };
      },
    });
    const result = await device.interactions.press({ kind: 'point', x, y: 25 }, { verify });
    assert.deepEqual(captures, frames);
    assert.equal(result.evidence?.changedFromBefore, changed);
    assert.equal(
      result.evidence?.screenshotDiff?.changedFromBefore,
      frames.length ? changed : undefined,
    );
  },
);

test('the coordinate dispatch keeps the backend receiver for methods that read this', async () => {
  // An in-process backend whose tap is a real method: the dispatch must invoke
  // it with the backend as its receiver, the way a bare call would not.
  const taps: Array<{ receiver: unknown; point: { x: number; y: number } }> = [];
  const backend: AgentDeviceBackend = {
    platform: 'ios',
    captureSnapshot: async () => ({ snapshot: selectorSnapshot() }),
    async tap(context, point) {
      taps.push({ receiver: this, point });
      void context;
      return { ok: true };
    },
  } satisfies AgentDeviceBackend;
  const device = createAgentDevice({
    backend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: selectorSnapshot() }]),
    policy: localCommandPolicy(),
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 200, y: 25 },
    { verify: false },
  );

  assert.equal(result.kind, 'point');
  assert.equal(taps.length, 1);
  assert.equal(taps[0]?.receiver, backend);
  assert.deepEqual(taps[0]?.point, { x: 200, y: 25 });
});

// The tree-coverage gate admits the pixel pair only when no covering node is a
// semantic touch target, or hittable and smaller than the point's resolved
// viewport. The ruling on #4297 (option a): the viewport-filling hittable
// container every real tree carries is exempt, so the gate stays reachable —
// the four cases below are the maintainer's list.
function node(overrides: {
  index: number;
  type: string;
  rect: { x: number; y: number; width: number; height: number };
  hittable?: boolean;
  parentIndex?: number;
  label?: string;
}): RawSnapshotNode {
  return { ...overrides };
}

async function pressWithGateTree(
  nodes: RawSnapshotNode[],
  point: { x: number; y: number },
): Promise<{ pairRan: boolean }> {
  const { writeFile } = await import('node:fs/promises');
  let pairRan = false;
  let tapped = false;
  const device = createInteractionDevice(makeSnapshotState(nodes), {
    tap: async () => {
      tapped = true;
    },
    clock: { now: () => 0, sleep: async () => {} },
    captureVerifyScreenshot: async (outPath) => {
      pairRan = true;
      const png = new PNG({ width: 4, height: 4 });
      png.data.fill(255);
      if (tapped) png.data[16] = 0;
      await writeFile(outPath, PNG.sync.write(png));
      return { ignoreTopHeightShare: 0.25 };
    },
  });
  const result = await device.interactions.press({ kind: 'point', ...point }, { verify: true });
  assert.ok(result.evidence);
  return { pairRan };
}

test('gate admits the pair past a full-screen hittable container that IS the viewport', async () => {
  // Android content FrameLayout shape: no window node, so the resolved
  // viewport is the largest-containing-rect fallback — the container itself.
  const { pairRan } = await pressWithGateTree(
    [
      node({ index: 0, type: 'FrameLayout', rect: { x: 0, y: 94, width: 1080, height: 2306 }, hittable: true }),
      node({ index: 1, type: 'Text', rect: { x: 40, y: 300, width: 400, height: 40 } }),
    ],
    { x: 540, y: 1200 },
  );
  assert.equal(pairRan, true);
});

test('gate admits the iOS full-screen CollectionView and still blocks its covering cells', async () => {
  // iOS Settings shape: the full-screen CollectionView is hittable and IS the
  // viewport (exempt), so a point only it covers opens the pair; the Cell and
  // Button under the same point are smaller than the viewport, so they keep
  // blocking and the pair never runs.
  const collectionView = node({
    index: 0,
    type: 'CollectionView',
    rect: { x: 0, y: 0, width: 440, height: 956 },
    hittable: true,
  });
  const windowNode = node({ index: 2, type: 'Window', rect: { x: 0, y: 0, width: 440, height: 956 } });
  const opened = await pressWithGateTree([collectionView, windowNode], { x: 200, y: 700 });
  assert.equal(opened.pairRan, true);

  const cellUnderThePoint = node({
    index: 1,
    type: 'Cell',
    rect: { x: 0, y: 660, width: 440, height: 80 },
    hittable: true,
    parentIndex: 0,
    label: 'General',
  });
  const blocked = await pressWithGateTree(
    [collectionView, cellUnderThePoint, windowNode],
    { x: 200, y: 700 },
  );
  assert.equal(blocked.pairRan, false);
});

test('gate keeps a full-screen semantic touch target blocking', async () => {
  const { pairRan } = await pressWithGateTree(
    [
      node({ index: 0, type: 'Button', rect: { x: 0, y: 0, width: 1080, height: 2400 }, hittable: true, label: 'Continue' }),
    ],
    { x: 540, y: 1200 },
  );
  assert.equal(pairRan, false);
});

test('gate exempts a hittable scrim whose rect contains the whole viewport', async () => {
  // The ruling's literal shape: the exempting direction is "the node's rect
  // contains the resolved viewport", so a full-screen scrim drawn beyond the
  // window bounds (oversized during a scale animation) still opens the pair.
  const { pairRan } = await pressWithGateTree(
    [
      node({ index: 0, type: 'Window', rect: { x: 0, y: 0, width: 440, height: 956 } }),
      node({ index: 1, type: 'View', rect: { x: -100, y: -100, width: 640, height: 1156 }, hittable: true }),
    ],
    { x: 200, y: 700 },
  );
  assert.equal(pairRan, true);
});

test('gate keeps a smaller hittable node under the point inside the container blocking', async () => {
  const { pairRan } = await pressWithGateTree(
    [
      node({ index: 0, type: 'FrameLayout', rect: { x: 0, y: 94, width: 1080, height: 2306 }, hittable: true }),
      node({
        index: 1,
        type: 'View',
        rect: { x: 400, y: 1100, width: 280, height: 200 },
        hittable: true,
        parentIndex: 0,
      }),
    ],
    { x: 540, y: 1200 },
  );
  assert.equal(pairRan, false);
});

test('gate admits the pair on the Redmi K60 Edge tree through the largest-containing-rect fallback', async () => {
  // The captured Edge tree (android-helper, #4297 2026-11-19): no window
  // nodes and no root node (Android emits neither), Java class names
  // isViewportRootNode never matches, and the content-root FrameLayout
  // 0,94 1080x2306 is hittable — the largest containing rect, so it IS the
  // resolved viewport. Under the old gate every point on this tree closed
  // the pixel pair.
  const edgeTreeNodes: RawSnapshotNode[] = [
    node({ index: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 94, width: 1080, height: 2306 }, hittable: true }),
    node({ index: 1, type: 'android.view.View', rect: { x: 0, y: 94, width: 1080, height: 120 }, parentIndex: 0 }),
    node({ index: 2, type: 'android.widget.EditText', rect: { x: 40, y: 140, width: 600, height: 60 }, parentIndex: 0, label: 'Search or type URL' }),
    node({ index: 3, type: 'android.view.View', rect: { x: 0, y: 260, width: 1080, height: 2140 }, parentIndex: 0 }),
  ];
  const { pairRan } = await pressWithGateTree(edgeTreeNodes, { x: 540, y: 1200 });
  assert.equal(pairRan, true);
});
