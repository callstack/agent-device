import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import {
  buttonSnapshot,
  createSettleDevice,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';
import { settleObservationCommand } from './settle.ts';

const SHEET_BUNDLE_ID = 'com.apple.SafariViewService';

function signInSheetSnapshot(): SnapshotState {
  return {
    ...makeSnapshotState(
      ['Continue', 'Sign in with Example', 'Email', 'Password', 'Cancel'].map((label, index) => ({
        index,
        depth: 0,
        type: 'Button',
        label,
        rect: { x: 10, y: 20 + index * 50, width: 200, height: 40 },
        hittable: true,
      })),
    ),
    iosSystemSurfaceBundleId: SHEET_BUNDLE_ID,
  };
}

async function genericSettle(baseline: SnapshotState, after: SnapshotState) {
  const device = createSettleDevice({
    stored: baseline,
    captureSnapshot: () => ({ snapshot: after }),
  });
  const settle = await settleObservationCommand(device, {
    session: 'default',
    baseline: surfaceScopedNodes(baseline),
    quietMs: 25,
    timeoutMs: 5_000,
  });
  return { device, settle };
}

const app = welcomeSnapshot();
const sheet = signInSheetSnapshot();

for (const route of ['scroll', 'back'] as const) {
  for (const transition of [
    { name: 'app-to-sheet', baseline: app, after: sheet, from: 'app', to: SHEET_BUNDLE_ID },
    { name: 'sheet-to-app', baseline: sheet, after: app, from: SHEET_BUNDLE_ID, to: 'app' },
  ]) {
    test(`targetless ${route} settle discloses the ${transition.name} surface change`, async () => {
      const { device, settle } = await genericSettle(transition.baseline, transition.after);

      assert.equal(settle.settled, true);
      assert.equal(settle.surfaceChange?.from, transition.from);
      assert.equal(settle.surfaceChange?.to, transition.to);
      assert.ok(settle.surfaceChange?.disclosure);
      assert.equal(settle.diff, undefined);
      assert.equal(settle.tail, undefined);
      assert.match(settle.hint ?? '', /different surfaces/);
      assert.match(settle.hint ?? '', /take a snapshot/i);
      const stored = (await device.sessions.get('default')) as { snapshot?: SnapshotState };
      assert.equal(
        stored.snapshot?.iosSystemSurfaceBundleId,
        transition.after.iosSystemSurfaceBundleId,
      );
    });
  }
}

function presentedSheetBaseline(nodeCount: number): SnapshotState {
  return {
    ...makeSnapshotState(
      Array.from({ length: nodeCount }, (_, index) => ({
        index,
        depth: 0,
        type: 'Button',
        label: `Sheet action ${index}`,
      })),
    ),
    presentedSurface: 'presented',
  };
}

for (const [flavour, nodeCount] of [
  ['interactive', 4],
  ['full', 6],
] as const) {
  test(`targetless back settle confirms a dismissed sheet from the ${flavour} baseline`, async () => {
    const { settle } = await genericSettle(presentedSheetBaseline(nodeCount), welcomeSnapshot());

    assert.equal(settle.settled, true);
    assert.ok(settle.waitedMs >= 1_500, `confirmation ended after ${settle.waitedMs}ms`);
  });
}

test('targetless back settle keeps the plain window when the baseline presented nothing', async () => {
  const absent = { ...buttonSnapshot(), presentedSurface: 'absent' as const };
  const { settle } = await genericSettle(absent, welcomeSnapshot());

  assert.equal(settle.settled, true);
  assert.ok(settle.waitedMs < 1_500, `plain window ended after ${settle.waitedMs}ms`);
});

test('targetless back settle confirms a broad replacement when the baseline fact is unknown', async () => {
  const { settle } = await genericSettle(buttonSnapshot(), welcomeSnapshot());

  assert.equal(settle.settled, true);
  assert.ok(settle.waitedMs >= 1_500, `confirmation ended after ${settle.waitedMs}ms`);
});
