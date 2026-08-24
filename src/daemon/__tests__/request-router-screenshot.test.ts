import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { legacyDispatchCapture } from './legacy-snapshot-capture-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

// `scroll` still executes through legacy platform dispatch; screenshot and click bind their fake
// at the facts/bind seam below instead (ADR 0019).
vi.mock('../../platforms/android/window-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/window-state.ts')>();
  return {
    ...actual,
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

import { createRequestHandler } from './test-device-runtime-gateway.ts';
import {
  screenshotRuntimeFixture,
  writeSolidPng,
  type ScreenshotRuntimeFixture,
  type ScreenshotRuntimeFixtureOptions,
} from './screenshot-runtime-fixture.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { PNG } from '../../utils/png.ts';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeSession as makeBaseSession } from '../../__tests__/test-utils/session-factories.ts';

function makeSession(name: string): SessionState {
  return makeBaseSession(name, { device: ANDROID_EMULATOR });
}

function makeIosSession(name: string): SessionState {
  return makeBaseSession(name, { device: IOS_SIMULATOR });
}

function makeMacOsMenubarSession(name: string): SessionState {
  return {
    name,
    device: {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
    surface: 'menubar',
    appBundleId: 'com.example.menubarapp',
  };
}

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
});

type ScreenshotRouter = Readonly<{
  handler: ReturnType<typeof createRequestHandler>;
  sessionStore: ReturnType<typeof makeSessionStore>;
  runtime: ScreenshotRuntimeFixture;
}>;

function screenshotRouter(
  session: SessionState,
  options: ScreenshotRuntimeFixtureOptions = {},
): ScreenshotRouter {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set(session.name, session);
  const runtime = screenshotRuntimeFixture(options);
  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, sessionStore, runtime };
}

function capturedPath(runtime: ScreenshotRuntimeFixture): string | undefined {
  return runtime.captureScreenshot.mock.calls[0]?.[0].outPath;
}

test('screenshot resolves relative positional path against request cwd', async () => {
  const callerCwd = mkdtempForTestSync('agent-device-screenshot-cwd-caller-');
  const { handler, sessionStore, runtime } = screenshotRouter(makeSession('default'));

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: ['evidence/test.png'],
    meta: { cwd: callerCwd, requestId: 'req-1', sessionExplicit: true },
  });

  expect(capturedPath(runtime)).toBe(path.join(callerCwd, 'evidence/test.png'));
  expect(path.isAbsolute(capturedPath(runtime)!)).toBe(true);
  const recordedAction = sessionStore.get('default')?.actions.at(-1);
  expect(recordedAction?.positionals).toEqual([path.join(callerCwd, 'evidence/test.png')]);
});

test('screenshot keeps absolute positional path unchanged', async () => {
  const absolutePath = path.join(os.tmpdir(), 'evidence/test.png');
  const { handler, sessionStore, runtime } = screenshotRouter(makeSession('default'));

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [absolutePath],
    meta: { cwd: '/some/other/dir', requestId: 'req-2', sessionExplicit: true },
  });

  expect(capturedPath(runtime)).toBe(absolutePath);
  const recordedAction = sessionStore.get('default')?.actions.at(-1);
  expect(recordedAction?.positionals).toEqual([absolutePath]);
});

test('screenshot resolves --out flag path against request cwd', async () => {
  const callerCwd = mkdtempForTestSync('agent-device-screenshot-out-cwd-');
  const { handler, sessionStore, runtime } = screenshotRouter(makeSession('default'));

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    flags: { out: 'evidence/test.png' },
    meta: { cwd: callerCwd, requestId: 'req-3', sessionExplicit: true },
  });

  expect(capturedPath(runtime)).toBe(path.join(callerCwd, 'evidence/test.png'));
  expect(path.isAbsolute(capturedPath(runtime)!)).toBe(true);
  const recordedAction = sessionStore.get('default')?.actions.at(-1);
  expect(recordedAction?.flags.out).toBe(path.join(callerCwd, 'evidence/test.png'));
});

test('screenshot runtime supplies default output path when none is requested', async () => {
  const { handler, runtime } = screenshotRouter(makeSession('default'));

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    meta: { requestId: 'req-default-screenshot' },
  });

  expect(response.ok).toBe(true);
  expect(capturedPath(runtime)).toContain('agent-device-screenshot-');
  expect(path.basename(capturedPath(runtime) ?? '')).toBe('screenshot.png');
  if (response.ok) {
    expect(response.data?.path).toBe(capturedPath(runtime));
  }
});

test('screenshot forwards macOS session surface to the bound capture', async () => {
  const { handler, runtime } = screenshotRouter(makeMacOsMenubarSession('default'));

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: ['/tmp/menubar.png'],
    meta: { requestId: 'req-surface-screenshot' },
  });

  expect(runtime.captureScreenshot.mock.calls[0]?.[0].options).toMatchObject({
    surface: 'menubar',
    appBundleId: 'com.example.menubarapp',
  });
});

test('click forwards macOS menubar session surface to the bound runtime', async () => {
  const { handler, runtime } = screenshotRouter(makeMacOsMenubarSession('default'));

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'click',
    positionals: ['100', '200'],
    meta: { requestId: 'req-surface-click' },
  });

  expect(runtime.tapPoint.mock.calls[0]?.[0]).toMatchObject({
    appBundleId: 'com.example.menubarapp',
    options: { surface: 'menubar' },
  });
});

test('router serializes concurrent commands for the same device across sessions', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('session-a', makeSession('session-a'));
  sessionStore.set('session-b', makeSession('session-b'));

  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const gates: Array<() => void> = [];
  const gate = async (label: string) => {
    order.push(`start-${label}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      gates.push(() => {
        active -= 1;
        order.push(`end-${label}`);
        resolve();
      });
    });
  };

  const runtime = screenshotRuntimeFixture({
    onCapture: async (input) => {
      writeSolidPng(input.outPath);
      await gate('screenshot');
    },
    onScroll: async () => {
      await gate('scroll');
    },
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const screenshotRequest = handler({
    token: 'test-token',
    session: 'session-a',
    command: 'screenshot',
    positionals: ['/tmp/first.png'],
    meta: { requestId: 'req-lock-1' },
  });

  await vi.waitFor(() => {
    expect(order).toEqual(['start-screenshot']);
  });

  const scrollRequest = handler({
    token: 'test-token',
    session: 'session-b',
    command: 'scroll',
    positionals: ['down'],
    meta: { requestId: 'req-lock-2' },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual(['start-screenshot']);

  gates.shift()?.();

  await vi.waitFor(() => {
    expect(order).toEqual(['start-screenshot', 'end-screenshot', 'start-scroll']);
  });

  gates.shift()?.();

  const [screenshotResponse, scrollResponse] = await Promise.all([
    screenshotRequest,
    scrollRequest,
  ]);

  expect(screenshotResponse.ok).toBe(true);
  expect(scrollResponse.ok).toBe(true);
  expect(maxActive).toBe(1);
  expect(order).toEqual(['start-screenshot', 'end-screenshot', 'start-scroll', 'end-scroll']);
});

test('iOS simulator screenshot response includes output dimensions and logical density metadata', async () => {
  const screenshotPath = path.join(os.tmpdir(), `agent-device-ios-meta-${Date.now()}.png`);
  const { handler } = screenshotRouter(makeIosSession('default'), {
    onCapture: (input) => writeSolidPng(input.outPath, 402, 874),
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    meta: { requestId: 'req-ios-screenshot-meta' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data).toMatchObject({
      path: screenshotPath,
      width: 402,
      height: 874,
      logicalWidth: 402,
      logicalHeight: 874,
      pixelDensity: 1,
    });
  }
});

test('non-iOS screenshot response tolerates malformed PNG metadata', async () => {
  const screenshotPath = path.join(os.tmpdir(), `agent-device-android-truncated-${Date.now()}.png`);
  const { handler } = screenshotRouter(makeSession('default'), {
    onCapture: (input) => fs.writeFileSync(input.outPath, Buffer.alloc(0)),
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    meta: { requestId: 'req-android-screenshot-malformed-png' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data).toMatchObject({ path: screenshotPath });
    expect(response.data).not.toHaveProperty('width');
    expect(response.data).not.toHaveProperty('height');
  }
});

test('iOS simulator screenshot omits logical density metadata after --scale downscale', async () => {
  const screenshotPath = path.join(os.tmpdir(), `agent-device-ios-scale-${Date.now()}.png`);
  const { handler } = screenshotRouter(makeIosSession('default'), {
    onCapture: (input) => writeSolidPng(input.outPath, 804, 1748),
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    flags: { screenshotScale: 0.5, screenshotPixelDensity: 2 },
    meta: { requestId: 'req-ios-screenshot-scale-meta' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data).toMatchObject({ path: screenshotPath, width: 402, height: 874 });
    expect(response.data).not.toHaveProperty('logicalWidth');
    expect(response.data).not.toHaveProperty('logicalHeight');
    expect(response.data).not.toHaveProperty('pixelDensity');
  }
});

test('screenshot rejects the removed max-size field from older remote clients', async () => {
  const { handler, runtime } = screenshotRouter(makeIosSession('default'));

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: ['./legacy-max-size.png'],
    flags: { screenshotMaxSize: 720 } as unknown as DaemonRequest['flags'],
    meta: { requestId: 'req-ios-screenshot-legacy-max-size' },
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toContain('screenshot --max-size was removed; use --scale');
  }
  expect(runtime.captureScreenshot).not.toHaveBeenCalled();
});

test('screenshot --pixel-density is rejected outside iOS-family simulators', async () => {
  const { handler, runtime } = screenshotRouter(makeSession('default'));

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: ['/tmp/android.png'],
    flags: { screenshotPixelDensity: 2 },
    meta: { requestId: 'req-unsupported-density' },
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.message).toContain('currently supported only on iOS-family simulators');
  }
  expect(runtime.captureScreenshot).not.toHaveBeenCalled();
});

test('screenshot --overlay-refs captures a fresh snapshot when the session has none', async () => {
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-${Date.now()}.png`);
  const order: string[] = [];
  const { handler, runtime } = screenshotRouter(makeSession('default'), {
    onCapture: (input) => {
      order.push('screenshot');
      writeSolidPng(input.outPath);
    },
    snapshotResult: () => {
      order.push('snapshot');
      return {
        backend: 'android',
        producer: 'android-uiautomator',
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeButton',
            label: 'Continue',
            hittable: true,
            rect: { x: 0, y: 0, width: 40, height: 20 },
          },
        ],
      };
    },
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    flags: { overlayRefs: true },
    meta: { requestId: 'req-overlay-missing-snapshot' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.overlayRefs).toEqual([
      {
        ref: 'e1',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 40, height: 20 },
        // The Android backend reports device-pixel rects, so the overlay draws them unprojected.
        overlayRect: { x: 0, y: 0, width: 40, height: 20 },
        center: { x: 20, y: 10 },
      },
    ]);
  }
  expect(order).toEqual(['screenshot', 'snapshot']);
  expect(runtime.binds).toHaveLength(1);
});

test('screenshot --overlay-refs uses interactive iOS presentation for row-like other nodes', async () => {
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-ios-${Date.now()}.png`);
  const { handler, sessionStore, runtime } = screenshotRouter(makeIosSession('default'), {
    onCapture: (input) => writeSolidPng(input.outPath, 402, 874),
    snapshotResult: () => ({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Application',
          label: 'New Expensify Dev',
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Other',
          label: '!, Open debugger to view warnings.',
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
        {
          index: 2,
          depth: 1,
          parentIndex: 0,
          type: 'ScrollView',
          label: 'Recent chats',
          rect: { x: 8, y: 212, width: 386, height: 600 },
        },
        {
          index: 3,
          depth: 2,
          parentIndex: 2,
          type: 'Other',
          label: 'Recent chats',
          rect: { x: 0, y: 220, width: 402, height: 16 },
        },
        {
          index: 4,
          depth: 2,
          parentIndex: 2,
          type: 'Other',
          label: 'Receipt missing details, Receipt scanning failed. Enter details manually.',
          rect: { x: 8, y: 367, width: 386, height: 64 },
        },
      ],
    }),
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    flags: { overlayRefs: true },
    meta: { requestId: 'req-overlay-ios-rows' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.overlayRefs).toEqual([
      {
        ref: 'e5',
        label: 'Receipt missing details, Receipt scanning failed. Enter details manually.',
        rect: { x: 8, y: 367, width: 386, height: 64 },
        overlayRect: { x: 8, y: 367, width: 386, height: 64 },
        center: { x: 201, y: 399 },
      },
    ]);
  }
  expect(runtime.captureSnapshot.mock.calls[0]?.[0].options).toMatchObject({
    interactiveOnly: true,
  });
  expect(sessionStore.get('default')?.snapshot?.nodes[4]?.type).toBe('Cell');
});

test('screenshot --overlay-refs uses a fresh snapshot instead of stale session snapshot', async () => {
  const session = makeSession('default');
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Stale',
        hittable: true,
        rect: { x: 0, y: 0, width: 40, height: 20 },
      },
    ]),
    createdAt: Date.now(),
  };
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-${Date.now()}.png`);
  const { handler, sessionStore } = screenshotRouter(session, {
    snapshotResult: () => ({
      backend: 'android',
      producer: 'android-uiautomator',
      nodes: [
        {
          index: 0,
          type: 'XCUIElementTypeButton',
          label: 'Fresh',
          hittable: true,
          rect: { x: 0, y: 0, width: 40, height: 20 },
        },
      ],
    }),
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    flags: { overlayRefs: true },
    meta: { requestId: 'req-overlay-ok' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.path).toBe(screenshotPath);
    expect(response.data?.overlayRefs).toEqual([
      {
        ref: 'e1',
        label: 'Fresh',
        rect: { x: 0, y: 0, width: 40, height: 20 },
        // The Android backend reports device-pixel rects, so the overlay draws them unprojected.
        overlayRect: { x: 0, y: 0, width: 40, height: 20 },
        center: { x: 20, y: 10 },
      },
    ]);
  }
  expect(sessionStore.get('default')?.snapshot?.nodes[0]?.label).toBe('Fresh');
  const png = PNG.sync.read(fs.readFileSync(screenshotPath));
  expect(Array.from(png.data.slice(0, 4))).not.toEqual([255, 255, 255, 255]);
});

test('screenshot --pixel-density keeps overlay refs aligned to scaled iOS simulator output', async () => {
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-2x-${Date.now()}.png`);
  const { handler } = screenshotRouter(makeIosSession('default'), {
    onCapture: (input) => writeSolidPng(input.outPath, 804, 1748),
    snapshotResult: () => ({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [
        { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
        {
          index: 1,
          type: 'XCUIElementTypeButton',
          label: 'Continue',
          hittable: true,
          rect: { x: 10, y: 20, width: 80, height: 30 },
        },
      ],
    }),
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    flags: { overlayRefs: true, screenshotPixelDensity: 2 },
    meta: { requestId: 'req-overlay-2x' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data).toMatchObject({
      width: 804,
      height: 1748,
      logicalWidth: 402,
      logicalHeight: 874,
      pixelDensity: 2,
      overlayRefs: [
        {
          ref: 'e2',
          label: 'Continue',
          overlayRect: { x: 20, y: 40, width: 160, height: 60 },
          center: { x: 100, y: 70 },
        },
      ],
    });
  }
});
