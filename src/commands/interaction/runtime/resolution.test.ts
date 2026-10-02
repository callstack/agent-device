import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BackendSnapshotOptions } from '../../../backend.ts';
import { ref, selector } from './selector-read-utils.ts';
import { resolveRecordedTarget } from '@agent-device/selectors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import type { Point } from '@agent-device/kernel/snapshot';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import {
  clickRefE2,
  createInteractionDevice,
  fillableSnapshot,
  iosTabBarSnapshot,
  mapPinAnnotationSnapshot,
  nonHittableCellSnapshot,
  nonTouchableGroupSnapshot,
  selectorSnapshot,
} from './__tests__/test-utils/index.ts';

test('runtime press resolves selector targets to the actionable node center', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
      return { ok: true };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.deepEqual(calls, [{ x: 60, y: 40 }]);
  assert.equal(result.kind, 'selector');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label=Continue' });
  assert.equal(result.node?.label, 'Continue');
  assert.deepEqual(result.selectorChain, [
    'role="button" label="Continue"',
    'label="Continue"',
    'value="Continue"',
  ]);
  assert.deepEqual(result.backendResult, { ok: true });
});

test('runtime selector interactions fall back to a full snapshot when interactive refresh misses', async () => {
  const calls: Point[] = [];
  const captureOptions: Array<BackendSnapshotOptions | undefined> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async (_context, options) => {
      captureOptions.push(options);
      return {
        snapshot: options?.interactiveOnly
          ? makeSnapshotState([])
          : makeSnapshotState([
              {
                index: 0,
                depth: 0,
                type: 'XCUIElementTypeCell',
                label: 'General',
                rect: { x: 0, y: 100, width: 320, height: 44 },
                hittable: true,
              },
            ]),
      };
    },
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.click(selector('label=General'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.label, 'General');
  assert.deepEqual(calls, [{ x: 160, y: 122 }]);
  assert.deepEqual(captureOptions, [
    { interactiveOnly: true, includeRects: true },
    { interactiveOnly: false, includeRects: true },
  ]);
});

test('runtime selector misses carry a structured reason for retrying adapters', async () => {
  const device = createInteractionDevice(makeSnapshotState([]));

  await assert.rejects(
    () => device.interactions.press(selector('id="profile-button"'), { session: 'default' }),
    (error: unknown) => {
      assert.equal(
        (error as { details?: Record<string, unknown> }).details?.reason,
        INTERACTION_ERROR_REASONS.selectorNotFound,
      );
      return true;
    },
  );
});

test('runtime click keeps distinct tab button centers when iOS reports the tab bar as hittable', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(iosTabBarSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const refResult = await device.interactions.click(ref('@e4'), {
    session: 'default',
  });
  const selectorResult = await device.interactions.click(selector('label=Settings'), {
    session: 'default',
  });

  assert.deepEqual(calls, [
    { x: 166, y: 822 },
    { x: 257, y: 822 },
  ]);
  assert.equal(refResult.kind, 'ref');
  assert.equal(refResult.node?.label, 'Library');
  assert.equal(selectorResult.kind, 'selector');
  assert.equal(selectorResult.node?.label, 'Settings');
});

test('runtime click keeps non-button semantic targets at their own center', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(nonHittableCellSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await clickRefE2(device);

  assert.deepEqual(calls, [{ x: 70, y: 30 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Account');
});

test('runtime press surfaces targetHittable and a hint when the final tap node is non-hittable (#1037)', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(nonHittableCellSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.press(ref('@e2'), { session: 'default' });

  // Press still proceeds and reports success — non-hittable is informational only.
  assert.deepEqual(calls, [{ x: 70, y: 30 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Account');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
  assert.match(result.hint ?? '', /@ref/);
});

test('runtime press omits targetHittable and hint when the resolved node is hittable', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async () => {},
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.targetHittable, undefined);
  assert.equal(result.hint, undefined);
});

// The #1280 measured shape: a hittable, identity-empty LinearLayout row
// container whose title lives on a NON-hittable TextView child.
function identityEmptyRowSnapshot(containerType = 'LinearLayout') {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: containerType,
      rect: { x: 0, y: 100, width: 300, height: 48 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'TextView',
      label: 'Connected devices',
      rect: { x: 0, y: 100, width: 300, height: 48 },
      hittable: false,
    },
  ]);
}

test('runtime press #1280 retarget: the response is entirely container-based; the descendant rides only the recordingTarget side channel', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(identityEmptyRowSnapshot(), {
    platform: 'android',
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await device.interactions.press(selector('role=linearlayout'), {
    session: 'default',
  });

  // Dispatch: the tap lands at the CONTAINER's center.
  assert.deepEqual(calls, [{ x: 150, y: 124 }]);
  assert.equal(result.kind, 'selector');
  // The whole runtime response describes the dispatched container — node,
  // chain, hittability. The descendant's `hittable: false` must not leak.
  assert.equal(result.node?.type, 'LinearLayout');
  assert.deepEqual(result.selectorChain, ['role="linearlayout"']);
  assert.equal(result.targetHittable, undefined);
  assert.equal(result.hint, undefined);
  // The retarget rides ONLY on the recording-only side channel.
  assert.equal(result.recordingTarget?.node.label, 'Connected devices');
  assert.deepEqual(result.recordingTarget?.selectorChain, [
    'role="textview" label="Connected devices"',
    'label="Connected devices"',
  ]);
  assert.equal(result.recordingTarget?.refLabel, 'Connected devices');
});

test('runtime fill #1280: fill is excluded from retargeting — the chain stays on the editable container and resolves for replay', async () => {
  // An identity-empty EDITABLE container (no id/label/value) with a labeled
  // non-editable TextView child. Retargeting a fill would record a chain
  // whose `editable=true` constraint the label descendant can never satisfy
  // — an unreplayable script — so fill must record as before, no retarget.
  const snapshot = identityEmptyRowSnapshot('EditText');
  const calls: Array<{ point: Point; text: string }> = [];
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    fill: async (_context, point, text) => {
      calls.push({ point, text });
    },
  });

  const result = await device.interactions.fill(selector('role=edittext'), 'hello', {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.deepEqual(calls, [{ point: { x: 150, y: 124 }, text: 'hello' }]);
  // No side channel: fill never retargets.
  assert.equal(result.recordingTarget, undefined);
  // The recorded chain belongs to the container and carries the editable
  // constraint...
  assert.deepEqual(result.selectorChain, ['role="edittext" editable=true']);
  // ...and it resolves back to the editable container on the record-time
  // tree — the saved script stays replayable.
  const resolved = resolveRecordedTarget(result.selectorChain!.join(' || '), snapshot.nodes, {
    platform: 'android',
    requireRect: true,
    allowDisambiguation: false,
  });
  assert.equal(resolved.kind === 'resolved' ? resolved.winner.type : undefined, 'EditText');
});

test('runtime fill surfaces targetHittable and a hint for a non-hittable selector match (Maps pin case, #1037)', async () => {
  const calls: Array<{ point: Point; text: string }> = [];
  const device = createInteractionDevice(mapPinAnnotationSnapshot(), {
    fill: async (_context, point, text) => {
      calls.push({ point, text });
    },
  });

  const result = await device.interactions.fill(
    selector('text="Anthropic - Headquarters"'),
    'ignored',
    { session: 'default' },
  );

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.label, 'Anthropic - Headquarters');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
  assert.deepEqual(calls, [{ point: { x: 192, y: 461 }, text: 'ignored' }]);
});

test('runtime click still promotes non-touchable nodes to hittable ancestors', async () => {
  const calls: Point[] = [];
  const device = createInteractionDevice(nonTouchableGroupSnapshot(), {
    tap: async (_context, point) => {
      calls.push(point);
    },
  });

  const result = await clickRefE2(device);

  assert.deepEqual(calls, [{ x: 160, y: 60 }]);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Clickable group');
});

test('runtime interactions reject unsupported macOS desktop and menubar surfaces', async () => {
  const desktop = createInteractionDevice(selectorSnapshot(), {
    platform: 'macos',
    sessionMetadata: { surface: 'desktop' },
    tap: async () => {
      throw new Error('desktop click should be rejected before backend tap');
    },
  });
  await assert.rejects(
    () => desktop.interactions.click({ kind: 'point', x: 1, y: 2 }, { session: 'default' }),
    /click is not supported on macOS desktop sessions yet/,
  );
  await assert.rejects(
    () =>
      desktop.interactions.click(
        { kind: 'point', x: 1, y: 2 },
        { session: 'default', metadata: { surface: 'app' } },
      ),
    /click is not supported on macOS desktop sessions yet/,
  );

  const menubar = createInteractionDevice(fillableSnapshot(), {
    platform: 'macos',
    sessionMetadata: { surface: 'menubar' },
    fill: async () => {
      throw new Error('menubar fill should be rejected before backend fill');
    },
  });
  await assert.rejects(
    () => menubar.interactions.fill(ref('@e1'), 'hello', { session: 'default' }),
    /fill is not supported on macOS menubar sessions yet/,
  );

  let pressed = false;
  const menubarPress = createInteractionDevice(fillableSnapshot(), {
    platform: 'macos',
    sessionMetadata: { surface: 'menubar' },
    tap: async () => {
      pressed = true;
    },
  });

  await menubarPress.interactions.press(ref('@e1'), { session: 'default' });

  assert.equal(pressed, true);
});
