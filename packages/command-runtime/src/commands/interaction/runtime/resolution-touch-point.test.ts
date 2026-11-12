import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Point } from '@agent-device/kernel/snapshot';
import { attachSnapshotNodeInteractionBounds } from '@agent-device/kernel/rect-center';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
} from '@agent-device/platform-android/mechanics';
import { createInteractionDevice } from './__tests__/test-utils/index.ts';
import { ref, selector } from './selector-read-utils.ts';

function postSnapshot() {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Link',
      label: 'feedItem-by-whiskers.test',
      rect: { x: 0, y: 180, width: 402, height: 520 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Link',
      label: "whiskers's avatar",
      rect: { x: 16, y: 196, width: 48, height: 48 },
      hittable: true,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Mochi napping in a sunbeam #caturday',
      rect: { x: 72, y: 246, width: 300, height: 36 },
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'A kitten asleep in sunlight.',
      rect: { x: 16, y: 292, width: 370, height: 330 },
      hittable: true,
    },
  ]);
}

test('runtime ref and selector paths dispatch the same parent-owned post point', async () => {
  const refCalls: Point[] = [];
  const selectorCalls: Point[] = [];
  const refDevice = createInteractionDevice(postSnapshot(), {
    tap: async (_context, point) => {
      refCalls.push(point);
      return { ok: true };
    },
  });
  const selectorDevice = createInteractionDevice(postSnapshot(), {
    tap: async (_context, point) => {
      selectorCalls.push(point);
      return { ok: true };
    },
  });

  await refDevice.interactions.click(ref('@e2'), { session: 'default' });
  await selectorDevice.interactions.click(selector('label="feedItem-by-whiskers.test"'), {
    session: 'default',
  });

  assert.equal(refCalls.length, 1);
  assert.deepEqual(selectorCalls, refCalls);
  assert.ok(refCalls[0]!.y < 292);
  assert.notDeepEqual(refCalls[0], { x: 201, y: 440 });
});

test('runtime press refuses a selector match with a zero-area rect and dispatches no tap', async () => {
  const taps: Point[] = [];
  // SpringBoard page 2 keeps page-1 icons in the tree as 0x0 rects at the origin.
  const snapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'SpringBoard',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Icon',
      label: 'Clock',
      rect: { x: 0, y: 0, width: 0, height: 0 },
      hittable: false,
    },
  ]);
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label="Clock"'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.equal(details?.dispatched, 'no');
      // No scroll container holds the icon, so no scroll is offered as the recovery.
      assert.equal(details?.scrollContainerRef, undefined);
      assert.equal(details?.hint, undefined);
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

/**
 * A Flutter screen on iOS at the top of its content (#4451), as the Simulator AX bridge presents it:
 * the scroll view and its content are siblings, and the content below the fold keeps a 0x0 rect.
 */
function scrolledOutButtonSnapshot(label = 'View all') {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: false,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'ScrollView',
      role: 'FlutterSemanticsScrollView',
      rect: { x: 0, y: 118, width: 402, height: 756 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      role: 'FlutterSemanticsObject',
      label: 'Tall block',
      rect: { x: 157, y: 546, width: 86, height: 27 },
      hittable: true,
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      role: 'FlutterSemanticsObject',
      label,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      hittable: false,
    },
  ]);
}

test('runtime press on a zero-area target beside a scroll container names the scroll that reveals it', async () => {
  const taps: Point[] = [];
  const device = createInteractionDevice(scrolledOutButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label="View all"'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.equal(details?.dispatched, 'no');
      assert.equal(details?.scrollContainerRef, '@e2');
      assert.match(String(details?.hint), /scroll <direction> --until 'label="View all"'/);
      return true;
    },
  );
  await assert.rejects(
    () => device.interactions.press(ref('@e4'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.equal(details?.scrollContainerRef, '@e2');
      // A scroll expires the ref frame, so the ref recovery steers to a selector instead.
      assert.match(String(details?.hint), /retry with a selector/);
      assert.match(String(details?.hint), /re-run snapshot -i/);
      assert.doesNotMatch(String(details?.hint), /--until/);
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test('the scroll a zero-area target is pointed at survives the shell', async () => {
  // The hint is copied into a shell: double quotes would expand the `$`, and a bare single-quote
  // wrap would end at the apostrophe.
  const device = createInteractionDevice(scrolledOutButtonSnapshot("Today's $5 deal"), {
    tap: async () => ({ ok: true }),
  });

  await assert.rejects(
    () => device.interactions.press(selector('label="Today\'s $5 deal"'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.match(String(details?.hint), /--until 'label="Today'\\''s \$5 deal"'/);
      return true;
    },
  );
});

test('runtime press on a Compose button dispatches its center only once its role node is folded', async () => {
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="android.view.View" resource-id="compose-container" bounds="[53,1856][1027,1982]"
      clickable="true" focusable="true" visible-to-user="true">
      <node class="android.widget.TextView" text="Continue with email" bounds="[352,1895][728,1943]"
        visible-to-user="true" />
      <node class="android.widget.Button" bounds="[53,1858][1027,1980]" visible-to-user="true" />
    </node>
  </hierarchy>`);
  const press = async (raw: boolean) => {
    const taps: Point[] = [];
    const device = createInteractionDevice(
      makeSnapshotState(buildUiHierarchySnapshot(tree, undefined, { raw }).nodes),
      {
        tap: async (_context, point) => {
          taps.push(point);
          return { ok: true };
        },
      },
    );
    const failure = await device.interactions
      .click(selector('id="compose-container"'), { session: 'default' })
      .then(
        () => undefined,
        (error: { details?: { reason?: string; dispatched?: string } }) => error,
      );
    return { taps, reason: failure?.details?.reason, dispatched: failure?.details?.dispatched };
  };

  assert.deepEqual(await press(false), {
    taps: [{ x: 540, y: 1919 }],
    reason: undefined,
    dispatched: undefined,
  });
  assert.deepEqual(await press(true), {
    taps: [],
    reason: 'covered_by_interactive_descendants',
    dispatched: 'no',
  });
});

test('runtime press offers no scroll for a zero-area target listed before the only scroll container', async () => {
  const state = scrolledOutButtonSnapshot();
  const [application, scrollView, , button] = state.nodes;
  const device = createInteractionDevice(
    makeSnapshotState([application!, { ...button!, index: 1 }, { ...scrollView!, index: 2 }]),
    { tap: async () => ({ ok: true }) },
  );

  await assert.rejects(
    () => device.interactions.press(selector('label="View all"'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.equal(details?.scrollContainerRef, undefined);
      assert.equal(details?.hint, undefined);
      return true;
    },
  );
});

test('runtime press offers no scroll for a measured target whose input bounds exclude it', async () => {
  const root = { x: 0, y: 0, width: 1080, height: 2400 };
  // A row with a real frame, wholly under the navigation bar the input bounds stop at.
  const row = attachSnapshotNodeInteractionBounds(
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      identifier: 'row',
      label: 'Row',
      hittable: true,
      rect: { x: 0, y: 2305, width: 1080, height: 95 },
    },
    { ...root, height: 2274 },
  );
  const snapshot = buildSnapshotState(
    {
      backend: 'android',
      producer: 'android-uiautomator',
      nodes: [
        { index: 0, depth: 0, type: 'Application', rect: root },
        { index: 1, depth: 1, parentIndex: 0, type: 'ScrollView', rect: root, hittable: true },
        row,
      ],
    },
    { snapshotRaw: true },
  );
  const device = createInteractionDevice(snapshot, {
    platform: 'android',
    tap: async () => ({ ok: true }),
  });

  await assert.rejects(
    () => device.interactions.press(selector('id=row'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.equal(details?.scrollContainerRef, undefined);
      assert.equal(details?.hint, undefined);
      return true;
    },
  );
});

test('runtime press names the scroll view, not a scroll bar listed after it, as the scroll container', async () => {
  const state = scrolledOutButtonSnapshot();
  const [application, scrollView, block, button] = state.nodes;
  const device = createInteractionDevice(
    makeSnapshotState([
      application!,
      scrollView!,
      {
        ...block!,
        type: 'Other',
        role: 'AXScrollBar',
        label: 'Vertical scroll bar, 2 pages',
        rect: { x: 396, y: 118, width: 6, height: 756 },
      },
      button!,
    ]),
    { tap: async () => ({ ok: true }) },
  );

  await assert.rejects(
    () => device.interactions.press(selector('label="View all"'), { session: 'default' }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'target_bounds_invalid');
      assert.equal(details?.scrollContainerRef, '@e2');
      return true;
    },
  );
});
