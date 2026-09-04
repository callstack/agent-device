import {
  ANDROID_DEVICE,
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/device-fixtures.ts';
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
import {
  SCREENSHOT_CROP_TARGET_CELLS,
  assertScreenshotCropPolicy,
  buildScreenshotCropWarnings,
  classifyScreenshotCropTarget,
  cropScreenshotToSelector,
} from '../screenshot-crop.ts';
import { writeSolidPng } from './screenshot-runtime-fixture.ts';

type CropTargetDevice = Readonly<{
  target: (typeof SCREENSHOT_CROP_TARGET_CELLS)[number]['target'];
  device: DeviceInfo;
  surface: SessionSurface | undefined;
}>;

/** One device per matrix cell: the classifier's whole reachable output, named by its cell. */
const CROP_TARGET_DEVICES: readonly CropTargetDevice[] = [
  { target: 'ios-simulator', device: IOS_SIMULATOR, surface: undefined },
  { target: 'android-emulator', device: ANDROID_EMULATOR, surface: undefined },
  { target: 'android-device', device: ANDROID_DEVICE, surface: undefined },
  { target: 'macos-app-window', device: MACOS_DEVICE, surface: 'app' },
  { target: 'ios-physical', device: IOS_DEVICE, surface: undefined },
  { target: 'macos-helper', device: MACOS_DEVICE, surface: undefined },
  { target: 'web', device: WEB_DESKTOP_DEVICE, surface: undefined },
  { target: 'linux', device: LINUX_DEVICE, surface: undefined },
  { target: 'tvos', device: TVOS_SIMULATOR, surface: undefined },
  {
    target: 'harmonyos',
    device: { platform: 'harmonyos', id: 'hmy-1', name: 'HarmonyOS', kind: 'device' },
    surface: undefined,
  },
  {
    target: 'vega',
    device: { platform: 'vega', id: 'vega-1', name: 'Vega TV', kind: 'device', target: 'tv' },
    surface: undefined,
  },
];

test('the classifier and the acceptance matrix agree one-to-one, and the accepted cells are exactly the evidenced ones', () => {
  const matrixTargets = SCREENSHOT_CROP_TARGET_CELLS.map((cell) => cell.target);
  expect(new Set(matrixTargets).size).toBe(matrixTargets.length);
  for (const row of CROP_TARGET_DEVICES) {
    expect(classifyScreenshotCropTarget(row.device, row.surface)).toBe(row.target);
  }
  expect(CROP_TARGET_DEVICES.map((row) => row.target)).toEqual(matrixTargets);
  for (const cell of SCREENSHOT_CROP_TARGET_CELLS) {
    if (cell.target === 'ios-simulator' || cell.target === 'android-emulator') {
      expect(cell.status).toBe('accepted');
    } else {
      expect(cell).toEqual({
        target: cell.target,
        status: 'rejected',
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      });
    }
  }
});

test('an apple device with an unpopulated reserved OS is a typed refusal, not a guess', () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'watch-1',
    name: 'Watch',
    kind: 'simulator',
    appleOs: 'watchos',
  };
  let refusal: unknown;
  try {
    classifyScreenshotCropTarget(device, undefined);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: SCREENSHOT_CROP_REASONS.targetNotAccepted },
  });
});

function expectPolicyRefusal(
  params: Readonly<{
    device: DeviceInfo;
    surface: SessionSurface | undefined;
    cropOn: string;
    overlayRefs: boolean;
    fullscreen: boolean;
  }>,
  expected: Record<string, unknown>,
): void {
  try {
    assertScreenshotCropPolicy(params);
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }
  throw new Error('the crop policy must refuse before device work');
}

const POLICY_BASE = { cropOn: 'label="Save"', overlayRefs: false, fullscreen: false } as const;

test('combination refusals are answered before selector validation and the matrix', () => {
  expectPolicyRefusal(
    { device: MACOS_DEVICE, surface: 'app', ...POLICY_BASE, overlayRefs: true },
    { code: 'INVALID_ARGS', details: { reason: SCREENSHOT_CROP_REASONS.frameMismatch } },
  );
  expectPolicyRefusal(
    { device: ANDROID_EMULATOR, surface: undefined, ...POLICY_BASE, fullscreen: true },
    { code: 'INVALID_ARGS', details: { reason: SCREENSHOT_CROP_REASONS.frameMismatch } },
  );
});

test('an invalid selector expression is refused with the selector reason', () => {
  expectPolicyRefusal(
    {
      device: ANDROID_EMULATOR,
      surface: undefined,
      cropOn: 'label="unterminated',
      overlayRefs: false,
      fullscreen: false,
    },
    { code: 'INVALID_ARGS', details: { reason: SCREENSHOT_CROP_REASONS.selectorInvalid } },
  );
});

test('a matrix-rejected target is refused with the pending-evidence reason', () => {
  expectPolicyRefusal(
    { device: ANDROID_DEVICE, surface: undefined, ...POLICY_BASE },
    {
      code: 'UNSUPPORTED_OPERATION',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      },
    },
  );
});

test('an accepted target with a valid selector passes the policy', () => {
  expect(() =>
    assertScreenshotCropPolicy({ device: ANDROID_EMULATOR, surface: undefined, ...POLICY_BASE }),
  ).not.toThrow();
});

test('the warning composition is the single owner: partial intersection and only', () => {
  expect(buildScreenshotCropWarnings(undefined)).toEqual([]);
  expect(buildScreenshotCropWarnings({ cropped: true, partialIntersection: false })).toEqual([]);
  const warnings = buildScreenshotCropWarnings({ cropped: true, partialIntersection: true });
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
    expect(outcome).toEqual({ cropped: true, partialIntersection: false });
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
    expect(outcome).toEqual({ cropped: true, partialIntersection: false });
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
    expect(outcome).toEqual({ cropped: true, partialIntersection: true });
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
