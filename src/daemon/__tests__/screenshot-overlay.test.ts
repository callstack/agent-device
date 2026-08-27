import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import { annotateScreenshotWithRefs, buildScreenshotOverlayRefs } from '../screenshot-overlay.ts';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

function writeSolidPng(filePath: string, width: number, height: number): void {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

test('buildScreenshotOverlayRefs reuses existing eN refs and promotes labeled children to hittable ancestors', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      hittable: true,
      rect: { x: 0, y: 0, width: 40, height: 20 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeStaticText',
      label: 'Continue',
      rect: { x: 2, y: 2, width: 30, height: 12 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 200, 100);

  assert.equal(overlayRefs.length, 1);
  assert.equal(overlayRefs[0]?.ref, 'e1');
  assert.equal(overlayRefs[0]?.label, 'Continue');
});

test('buildScreenshotOverlayRefs promotes labeled children to actionable ancestors before hittable roots', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeApplication',
      label: 'Settings',
      hittable: true,
      rect: { x: 0, y: 0, width: 100, height: 200 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'General',
      rect: { x: 10, y: 20, width: 80, height: 30 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'XCUIElementTypeStaticText',
      label: 'General',
      rect: { x: 14, y: 26, width: 40, height: 12 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 200, 400);

  assert.deepEqual(overlayRefs, [
    {
      ref: 'e2',
      label: 'General',
      rect: { x: 10, y: 20, width: 80, height: 30 },
      overlayRect: { x: 20, y: 40, width: 160, height: 60 },
      center: { x: 100, y: 70 },
    },
  ]);
});

test('buildScreenshotOverlayRefs includes non-hittable iOS cell rows', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeApplication',
      label: 'New Expensify Dev',
      hittable: true,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeScrollView',
      label: 'Recent chats',
      rect: { x: 8, y: 212, width: 386, height: 600 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Receipt missing details, Receipt scanning failed. Enter details manually.',
      hittable: false,
      rect: { x: 8, y: 367, width: 386, height: 64 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 804, 1748);

  assert.deepEqual(overlayRefs, [
    {
      ref: 'e3',
      label: 'Receipt missing details, Receipt scanning failed. Enter details manually.',
      rect: { x: 8, y: 367, width: 386, height: 64 },
      overlayRect: { x: 16, y: 734, width: 772, height: 128 },
      center: { x: 402, y: 798 },
    },
  ]);
});

test('buildScreenshotOverlayRefs suppresses contained duplicates with the same label, keeping the smaller rect', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      hittable: true,
      rect: { x: 0, y: 0, width: 80, height: 40 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      hittable: true,
      rect: { x: 10, y: 10, width: 30, height: 16 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 200, 100);

  assert.deepEqual(
    overlayRefs.map((overlayRef) => overlayRef.ref),
    ['e2'],
  );
});

test('buildScreenshotOverlayRefs projects against the viewport instead of snapshot outliers', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeApplication',
      label: 'Settings',
      rect: { x: 0, y: 0, width: 100, height: 200 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeImage',
      rect: { x: -30, y: 150, width: 160, height: 40 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 80, height: 30 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 200, 400);

  assert.deepEqual(overlayRefs[0]?.overlayRect, {
    x: 20,
    y: 40,
    width: 160,
    height: 60,
  });
  assert.deepEqual(overlayRefs[0]?.center, {
    x: 100,
    y: 70,
  });
});

test('buildScreenshotOverlayRefs skips generic actionable container labels when specific children exist', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeApplication',
      rect: { x: 0, y: 0, width: 100, height: 200 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeToolbar',
      label: 'Toolbar',
      rect: { x: 0, y: 150, width: 100, height: 30 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'XCUIElementTypeSearchField',
      label: 'Search',
      rect: { x: 8, y: 154, width: 70, height: 20 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 200, 400);

  assert.deepEqual(
    overlayRefs.map((overlayRef) => overlayRef.label),
    ['Search'],
  );
});

test('buildScreenshotOverlayRefs prefers descendant text over generic android resource ids', () => {
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 100, height: 200 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      identifier: 'com.android.settings:id/dashboard_tile',
      hittable: true,
      rect: { x: 0, y: 20, width: 100, height: 24 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.ImageView',
      identifier: 'android:id/icon',
      rect: { x: 4, y: 24, width: 10, height: 10 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Network & internet',
      rect: { x: 20, y: 24, width: 40, height: 10 },
    },
  ]);

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 200, 400);

  assert.deepEqual(overlayRefs, [
    {
      ref: 'e2',
      label: 'Network & internet',
      rect: { x: 0, y: 20, width: 100, height: 24 },
      overlayRect: { x: 0, y: 40, width: 200, height: 48 },
      center: { x: 100, y: 64 },
    },
  ]);
});

test('buildScreenshotOverlayRefs keeps Android pixel rects aligned with screenshots', () => {
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        type: 'android.widget.ScrollView',
        rect: { x: 0, y: 0, width: 1344, height: 2920 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'android.widget.LinearLayout',
        hittable: true,
        rect: { x: 0, y: 2697, width: 1344, height: 223 },
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'android.widget.TextView',
        label: 'Storage',
        rect: { x: 240, y: 2745, width: 205, height: 81 },
      },
    ],
    { backend: 'android' },
  );

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 1344, 2992);

  assert.deepEqual(overlayRefs, [
    {
      ref: 'e2',
      label: 'Storage',
      rect: { x: 0, y: 2697, width: 1344, height: 223 },
      overlayRect: { x: 0, y: 2697, width: 1344, height: 223 },
      center: { x: 672, y: 2809 },
    },
  ]);
});

test('buildScreenshotOverlayRefs includes unlabeled Android bottom tab controls', () => {
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        type: 'android.widget.FrameLayout',
        rect: { x: 0, y: 0, width: 1344, height: 2992 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'android.widget.ScrollView',
        hittable: true,
        rect: { x: 0, y: 159, width: 1344, height: 2593 },
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'android.widget.TextView',
        label: 'Agent Device Tester',
        rect: { x: 54, y: 181, width: 770, height: 86 },
      },
      {
        index: 3,
        parentIndex: 0,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 72, y: 2724, width: 192, height: 132 },
      },
      {
        index: 4,
        parentIndex: 0,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 436, y: 2724, width: 192, height: 132 },
      },
      {
        index: 5,
        parentIndex: 0,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 800, y: 2724, width: 192, height: 132 },
      },
      {
        index: 6,
        parentIndex: 0,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 1164, y: 2724, width: 132, height: 132 },
      },
    ],
    { backend: 'android' },
  );

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 1344, 2992);

  assert.deepEqual(
    overlayRefs.map((overlayRef) => overlayRef.ref),
    ['e4', 'e5', 'e6', 'e7'],
  );
  assert.ok(
    overlayRefs.every((overlayRef) => !overlayRef.label),
    'unlabeled Android tab controls should still get visual refs',
  );
});

test('buildScreenshotOverlayRefs keeps nested unlabeled Android controls separate', () => {
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        type: 'android.widget.FrameLayout',
        rect: { x: 0, y: 0, width: 1344, height: 2992 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 80, y: 240, width: 400, height: 240 },
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'android.view.ViewGroup',
        hittable: true,
        rect: { x: 120, y: 280, width: 160, height: 120 },
      },
    ],
    { backend: 'android' },
  );

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 1344, 2992);

  assert.deepEqual(
    overlayRefs.map((overlayRef) => overlayRef.ref),
    ['e2', 'e3'],
  );
  assert.ok(overlayRefs.every((overlayRef) => !overlayRef.label));
});

test('buildScreenshotOverlayRefs trims Android row spacing from unlabeled action containers', () => {
  const snapshot = makeSnapshotState(
    [
      {
        index: 0,
        type: 'android.widget.ScrollView',
        rect: { x: 0, y: 0, width: 1344, height: 2920 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'android.widget.LinearLayout',
        hittable: true,
        rect: { x: 0, y: 447, width: 1344, height: 282 },
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'android.widget.TextView',
        label: 'Google',
        rect: { x: 240, y: 495, width: 190, height: 81 },
      },
      {
        index: 3,
        parentIndex: 1,
        type: 'android.widget.TextView',
        label: 'Services & preferences',
        rect: { x: 240, y: 576, width: 425, height: 57 },
      },
    ],
    { backend: 'android' },
  );

  const overlayRefs = buildScreenshotOverlayRefs(snapshot, 1344, 2992);

  assert.deepEqual(overlayRefs, [
    {
      ref: 'e2',
      label: 'Google',
      rect: { x: 0, y: 447, width: 1344, height: 282 },
      overlayRect: { x: 0, y: 447, width: 1344, height: 234 },
      center: { x: 672, y: 564 },
    },
  ]);
});

test('annotateScreenshotWithRefs draws the overlay onto the saved PNG', async () => {
  const root = mkdtempForTestSync('agent-device-screenshot-overlay-');
  const screenshotPath = path.join(root, 'screen.png');
  writeSolidPng(screenshotPath, 100, 50);
  const snapshot = makeSnapshotState([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      label: 'Login',
      hittable: true,
      rect: { x: 10, y: 10, width: 20, height: 10 },
    },
  ]);

  const overlayRefs = await annotateScreenshotWithRefs({
    screenshotPath,
    snapshot,
  });

  assert.equal(overlayRefs.length, 1);
  const png = PNG.sync.read(fs.readFileSync(screenshotPath));
  const borderPixelIndex = (png.width * 10 + 10) * 4;
  assert.notDeepEqual(
    Array.from(png.data.slice(borderPixelIndex, borderPixelIndex + 4)),
    [255, 255, 255, 255],
  );
});
