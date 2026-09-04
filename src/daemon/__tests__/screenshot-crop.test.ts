import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { readPngSize } from '@agent-device/capture-kit/png-size';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { SnapshotResult } from '@agent-device/contracts/snapshot-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  RawSnapshotNode,
  Rect,
  SnapshotProvenance,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { SessionState } from '../types.ts';
import { buildScreenshotCropWarnings, cropScreenshotToSelector } from '../screenshot-crop.ts';
import { writeSolidPng } from './screenshot-runtime-fixture.ts';

test('the warning composition is the single owner: partial intersection and only', () => {
  expect(buildScreenshotCropWarnings(undefined)).toEqual([]);
  expect(buildScreenshotCropWarnings({ partialIntersection: false })).toEqual([]);
  const warnings = buildScreenshotCropWarnings({ partialIntersection: true });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(new RegExp(`^${SCREENSHOT_CROP_REASONS.partialIntersection}: `));
});

const ANDROID_ROOT: RawSnapshotNode = {
  index: 0,
  depth: 0,
  type: 'android.widget.FrameLayout',
  rect: { x: 0, y: 0, width: 100, height: 50 },
};

function androidTree(saveRect: Rect): RawSnapshotNode[] {
  return [
    ANDROID_ROOT,
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Save',
      rect: saveRect,
    },
  ];
}

const IOS_TREE: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Save',
    rect: { x: 10, y: 10, width: 100, height: 40 },
    hittable: true,
  },
];

type CropSeamParams = Readonly<{
  device: DeviceInfo;
  surface?: SessionSurface;
  cropOn?: string;
  nodes: RawSnapshotNode[];
  png: Readonly<{ width: number; height: number }>;
  truncated?: boolean;
  quality?: SnapshotQualityVerdict;
  provenance: SnapshotProvenance;
}>;

type CropSeam = Readonly<{
  session: SessionState;
  screenshotPath: string;
  captureSnapshot: ReturnType<typeof vi.fn>;
  run: () => Promise<unknown>;
  dispose: () => void;
}>;

function cropSeam(params: CropSeamParams): CropSeam {
  const session = makeSession('default', { device: params.device, surface: params.surface });
  const screenshotPath = path.join(
    os.tmpdir(),
    `agent-device-crop-on-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  writeSolidPng(screenshotPath, params.png.width, params.png.height);
  const captureSnapshot = vi.fn(async (): Promise<SnapshotResult> => ({
    nodes: params.nodes,
    ...params.provenance,
    ...(params.truncated === undefined ? {} : { truncated: params.truncated }),
    ...(params.quality === undefined ? {} : { quality: params.quality }),
  }));
  return {
    session,
    screenshotPath,
    captureSnapshot,
    run: () =>
      cropScreenshotToSelector({
        device: params.device,
        session,
        surface: params.surface,
        cropOn: params.cropOn ?? 'label="Save"',
        screenshotPath,
        logPath: path.join(os.tmpdir(), 'agent-device-crop-on-daemon.log'),
        dispatchContext: {},
        captureSnapshot,
      }),
    dispose: () => {
      fs.rmSync(screenshotPath, { force: true });
    },
  };
}

test('an android crop runs the fresh full-tree capture once and leaves the session snapshot untouched', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: androidTree({ x: 10, y: 10, width: 40, height: 20 }),
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
  });
  try {
    const outcome = await seam.run();
    expect(outcome).toEqual({ partialIntersection: false });
    expect(await readPngSize(seam.screenshotPath)).toEqual({ width: 40, height: 20 });
    expect(seam.captureSnapshot).toHaveBeenCalledTimes(1);
    const options = seam.captureSnapshot.mock.calls[0]?.[0].options;
    expect(options.interactiveOnly).toBe(false);
    expect(options.includeRects).toBe(true);
    expect(options.surface).toBeUndefined();
    expect(options.appBundleId).toBeUndefined();
    expect(seam.session.snapshot).toBeUndefined();
    expect(seam.session.snapshotGeneration).toBeUndefined();
  } finally {
    seam.dispose();
  }
});

test('an iOS simulator crop projects the points-space frame into the 3x capture', async () => {
  const seam = cropSeam({
    device: IOS_SIMULATOR,
    nodes: IOS_TREE,
    provenance: { backend: 'xctest', producer: 'apple-runner' },
    png: { width: 1170, height: 2532 },
  });
  try {
    const outcome = await seam.run();
    expect(outcome).toEqual({ partialIntersection: false });
    expect(await readPngSize(seam.screenshotPath)).toEqual({ width: 300, height: 120 });
  } finally {
    seam.dispose();
  }
});

test('a frame that runs past the image is clipped and reported partial', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: androidTree({ x: 80, y: 10, width: 50, height: 20 }),
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
  });
  try {
    const outcome = await seam.run();
    expect(outcome).toEqual({ partialIntersection: true });
    expect(await readPngSize(seam.screenshotPath)).toEqual({ width: 20, height: 20 });
  } finally {
    seam.dispose();
  }
});

test('a frame that occupies no image pixel refuses without writing', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: androidTree({ x: 200, y: 100, width: 10, height: 10 }),
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
  });
  try {
    await expect(seam.run()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: SCREENSHOT_CROP_REASONS.emptyIntersection },
    });
    expect(await readPngSize(seam.screenshotPath)).toEqual({ width: 100, height: 50 });
  } finally {
    seam.dispose();
  }
});

test('a sparse crop capture is an unreadable refusal, not a missing target', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: androidTree({ x: 10, y: 10, width: 40, height: 20 }),
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
    quality: { state: 'sparse', backend: 'tree' },
  });
  try {
    await expect(seam.run()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: SCREENSHOT_CROP_REASONS.captureUnreadable },
    });
    expect(await readPngSize(seam.screenshotPath)).toEqual({ width: 100, height: 50 });
  } finally {
    seam.dispose();
  }
});

test('a truncated no-match cannot prove the target absent', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: [ANDROID_ROOT],
    cropOn: 'label="Missing"',
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
    truncated: true,
  });
  try {
    await expect(seam.run()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: SCREENSHOT_CROP_REASONS.captureIncomplete },
    });
  } finally {
    seam.dispose();
  }
});

test('a complete no-match is a missing target with the find pointer', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: [ANDROID_ROOT],
    cropOn: 'label="Missing"',
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
  });
  try {
    await expect(seam.run()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetNotFound,
        hint: 'find label="Missing" list',
      },
    });
  } finally {
    seam.dispose();
  }
});

test('an ambiguous match refuses with the candidates, not a first-wins crop', async () => {
  const seam = cropSeam({
    device: ANDROID_EMULATOR,
    nodes: [
      ANDROID_ROOT,
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'android.widget.Button',
        label: 'Save',
        rect: { x: 5, y: 5, width: 20, height: 10 },
      },
      {
        index: 2,
        depth: 1,
        parentIndex: 0,
        type: 'android.widget.Button',
        label: 'Save',
        rect: { x: 60, y: 5, width: 20, height: 10 },
      },
    ],
    provenance: { backend: 'android', producer: 'android-uiautomator' },
    png: { width: 100, height: 50 },
  });
  try {
    await expect(seam.run()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetAmbiguous,
        candidates: ['Save', 'Save'],
        matches: 2,
      },
    });
    expect(await readPngSize(seam.screenshotPath)).toEqual({ width: 100, height: 50 });
  } finally {
    seam.dispose();
  }
});
