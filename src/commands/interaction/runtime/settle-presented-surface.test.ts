import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PresentedSurface, SnapshotState } from '@agent-device/kernel/snapshot';
import { ref, selector } from './selector-read-utils.ts';
import { createSettleDevice } from './__tests__/settle-device-fixtures.ts';
import {
  elementCatalogTabSnapshot,
  elementSettingsTabSnapshot,
} from './stable-capture.fixtures.ts';

// Each settle route hands the loop its own baseline, and the producer's presented-surface fact has
// to arrive with it (#3565): a tab switch from a screen read `absent` keeps the plain window, while
// the same broad replacement without that reading still pays the confirmation floor. The tab
// switch is the transition #3470 measured; budgets run on the injected clock.

function stamped(snapshot: SnapshotState, presentedSurface: PresentedSurface): SnapshotState {
  return { ...snapshot, presentedSurface };
}

/** A press that switches from the catalog tab to the settings tab, with the given baseline fact. */
function tabSwitchDevice(params: { stored: PresentedSurface; preActionCaptureFails?: boolean }) {
  const catalog = elementCatalogTabSnapshot();
  let captures = 0;
  return createSettleDevice({
    stored: stamped(catalog, params.stored),
    captureSnapshot: () => {
      captures += 1;
      if (captures === 1 && params.preActionCaptureFails) throw new Error('capture unavailable');
      return {
        snapshot:
          captures === 1
            ? stamped(catalog, params.stored)
            : stamped(elementSettingsTabSnapshot(), 'absent'),
      };
    },
  });
}

function settingsTabRef(): string {
  const node = elementCatalogTabSnapshot().nodes.find(
    (candidate) => candidate.label === 'Settings',
  );
  assert.ok(node?.ref);
  return `@${node.ref}`;
}

const ROUTES = [
  ['a selector press', () => selector('label=Settings')],
  ['an @ref press', () => ref(settingsTabRef())],
] as const;

for (const [label, target] of ROUTES) {
  test(`${label} carries an absent baseline into the loop: a tab switch keeps the plain window`, async () => {
    const device = tabSwitchDevice({ stored: 'absent' });

    const result = await device.interactions.press(target(), { session: 'default', settle: {} });

    assert.equal(result.settle?.settled, true);
    assert.ok(result.settle.waitedMs < 1_500, `paid the floor: ${result.settle.waitedMs}ms`);
  });

  test(`${label} keeps the confirmation when the baseline's producer could not answer`, async () => {
    const device = tabSwitchDevice({ stored: 'unknown' });

    const result = await device.interactions.press(target(), { session: 'default', settle: {} });

    assert.equal(result.settle?.settled, true);
    assert.ok(result.settle.waitedMs >= 1_500, `lost the floor: ${result.settle.waitedMs}ms`);
  });
}

test('a point press whose evidence capture failed does not trust the stored fact', async () => {
  // With no capture of its own, the baseline is the stored tree, which may predate a side effect
  // this layer cannot see: its `absent` must not rule the confirmation out.
  const device = tabSwitchDevice({ stored: 'absent', preActionCaptureFails: true });

  const result = await device.interactions.press(
    { kind: 'point', x: 300, y: 820 },
    { session: 'default', settle: {} },
  );

  assert.equal(result.settle?.settled, true);
  assert.ok(result.settle.waitedMs >= 1_500, `trusted a stored fact: ${result.settle.waitedMs}ms`);
});
