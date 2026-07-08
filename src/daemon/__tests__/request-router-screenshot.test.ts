import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

import { dispatchCommand } from '../../core/dispatch.ts';
import { createRequestHandler } from '../request-router.ts';
import { dispatchScreenshotViaRuntime } from '../screenshot-runtime.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { attachRefs } from '../../kernel/snapshot.ts';
import { PNG } from '../../utils/png.ts';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeSession as makeBaseSession } from '../../__tests__/test-utils/session-factories.ts';

const mockDispatch = vi.mocked(dispatchCommand);

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
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
});

function writeSolidPng(filePath: string, width = 100, height = 50): void {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

test('screenshot resolves relative positional path against request cwd', async () => {
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-screenshot-cwd-caller-'));
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));

  let capturedPath: string | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    if (command === 'screenshot') {
      capturedPath = positionals[0];
      if (capturedPath) {
        writeSolidPng(capturedPath);
      }
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: ['evidence/test.png'],
    meta: { cwd: callerCwd, requestId: 'req-1', sessionExplicit: true },
  });

  expect(capturedPath).toBeTruthy();
  expect(capturedPath).toBe(path.join(callerCwd, 'evidence/test.png'));
  expect(path.isAbsolute(capturedPath!)).toBe(true);
  const recordedAction = sessionStore.get('default')?.actions.at(-1);
  expect(recordedAction?.positionals).toEqual([path.join(callerCwd, 'evidence/test.png')]);
});

test('default screenshot temp directory is cleaned when capture fails', async () => {
  const session = makeSession('default');
  let capturedPath: string | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    if (command === 'screenshot') capturedPath = positionals[0];
    throw new Error('capture failed');
  });

  await expect(
    dispatchScreenshotViaRuntime({
      session,
      sessionName: session.name,
      outputPlacement: 'default',
      dispatchContext: {},
    }),
  ).rejects.toThrow(/capture failed/);

  expect(capturedPath).toBeTruthy();
  expect(path.basename(capturedPath!)).toBe('screenshot.png');
  expect(fs.existsSync(path.dirname(capturedPath!))).toBe(false);
});

test('session-backed iOS simulator screenshots skip redundant boot probe', async () => {
  const session = makeIosSession('ios');
  const outPath = path.join(os.tmpdir(), 'agent-device-ios-session-screenshot.png');
  let capturedContext: Parameters<typeof dispatchCommand>[4];

  mockDispatch.mockImplementation(async (_device, _command, _positionals, _outPath, context) => {
    capturedContext = context;
    return { path: outPath };
  });

  await dispatchScreenshotViaRuntime({
    session,
    sessionName: session.name,
    outPath,
    outputPlacement: 'positional',
    dispatchContext: {},
  });

  expect(capturedContext?.skipIosSimulatorBootCheck).toBe(true);
});

test('router serializes concurrent commands for the same device across sessions', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('session-a', makeSession('session-a'));
  sessionStore.set('session-b', makeSession('session-b'));

  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const gates: Array<() => void> = [];

  mockDispatch.mockImplementation(async (_device, command) => {
    order.push(`start-${command}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (command === 'screenshot') {
      writeSolidPng('/tmp/first.png');
    }
    await new Promise<void>((resolve) => {
      gates.push(() => {
        active -= 1;
        order.push(`end-${command}`);
        resolve();
      });
    });
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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

test('screenshot forwards macOS session surface to dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeMacOsMenubarSession('default'));

  mockDispatch.mockImplementation(async () => ({}));

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: ['/tmp/menubar.png'],
    meta: { requestId: 'req-surface-screenshot' },
  });

  expect(mockDispatch.mock.calls[0]?.[4]).toMatchObject({
    surface: 'menubar',
    appBundleId: 'com.example.menubarapp',
  });
});

test('click forwards macOS menubar session surface to dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeMacOsMenubarSession('default'));

  mockDispatch.mockImplementation(async () => ({}));

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'click',
    positionals: ['100', '200'],
    meta: { requestId: 'req-surface-click' },
  });

  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[4]).toMatchObject({
    surface: 'menubar',
    appBundleId: 'com.example.menubarapp',
  });
});

test('screenshot keeps absolute positional path unchanged', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));

  const absolutePath = path.join(os.tmpdir(), 'evidence/test.png');
  let capturedPath: string | undefined;

  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    if (command === 'screenshot') {
      capturedPath = positionals[0];
      if (capturedPath) {
        writeSolidPng(capturedPath);
      }
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [absolutePath],
    meta: { cwd: '/some/other/dir', requestId: 'req-2', sessionExplicit: true },
  });

  expect(capturedPath).toBe(absolutePath);
  const recordedAction = sessionStore.get('default')?.actions.at(-1);
  expect(recordedAction?.positionals).toEqual([absolutePath]);
});

test('screenshot runtime supplies default output path when none is requested', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));

  let capturedPath: string | undefined;
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    if (command === 'screenshot') {
      capturedPath = positionals[0];
      if (capturedPath) {
        writeSolidPng(capturedPath);
      }
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    meta: { requestId: 'req-default-screenshot' },
  });

  expect(response.ok).toBe(true);
  expect(capturedPath).toContain('agent-device-screenshot-');
  expect(path.basename(capturedPath ?? '')).toBe('screenshot.png');
  if (response.ok) {
    expect(response.data?.path).toBe(capturedPath);
  }
});

test('iOS simulator screenshot response includes output dimensions and logical density metadata', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeIosSession('default'));
  const screenshotPath = path.join(os.tmpdir(), `agent-device-ios-meta-${Date.now()}.png`);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      writeSolidPng(screenshotPath, 402, 874);
      return { path: screenshotPath };
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
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
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));
  const screenshotPath = path.join(os.tmpdir(), `agent-device-android-truncated-${Date.now()}.png`);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      fs.writeFileSync(screenshotPath, Buffer.alloc(0));
      return { path: screenshotPath };
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
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

test('iOS simulator screenshot omits logical density metadata after --max-size downscale', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeIosSession('default'));
  const screenshotPath = path.join(os.tmpdir(), `agent-device-ios-max-size-${Date.now()}.png`);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      writeSolidPng(screenshotPath, 804, 1748);
      return { path: screenshotPath };
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [screenshotPath],
    flags: { screenshotMaxSize: 437, screenshotPixelDensity: 2 },
    meta: { requestId: 'req-ios-screenshot-max-size-meta' },
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data).toMatchObject({
      path: screenshotPath,
      width: 201,
      height: 437,
    });
    expect(response.data).not.toHaveProperty('logicalWidth');
    expect(response.data).not.toHaveProperty('logicalHeight');
    expect(response.data).not.toHaveProperty('pixelDensity');
  }
});

test('screenshot resolves --out flag path against request cwd', async () => {
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-screenshot-out-cwd-'));
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));

  let capturedOut: string | undefined;

  mockDispatch.mockImplementation(async (_device, command, _positionals, outPath) => {
    if (command === 'screenshot') {
      capturedOut = outPath;
      if (capturedOut) {
        writeSolidPng(capturedOut);
      }
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  await handler({
    token: 'test-token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    flags: { out: 'evidence/test.png' },
    meta: { cwd: callerCwd, requestId: 'req-3', sessionExplicit: true },
  });

  expect(capturedOut).toBeTruthy();
  expect(capturedOut).toBe(path.join(callerCwd, 'evidence/test.png'));
  expect(path.isAbsolute(capturedOut!)).toBe(true);
  const recordedAction = sessionStore.get('default')?.actions.at(-1);
  expect(recordedAction?.flags.out).toBe(path.join(callerCwd, 'evidence/test.png'));
});

test('screenshot --overlay-refs captures a fresh snapshot when the session has none', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-${Date.now()}.png`);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      writeSolidPng(screenshotPath);
      return { path: screenshotPath };
    }
    if (command === 'snapshot') {
      return {
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
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
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
        overlayRect: { x: 0, y: 0, width: 100, height: 50 },
        center: { x: 50, y: 25 },
      },
    ]);
  }
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['screenshot', 'snapshot']);
});

test('screenshot --overlay-refs uses interactive iOS presentation for row-like other nodes', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeIosSession('default'));
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-ios-${Date.now()}.png`);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      writeSolidPng(screenshotPath, 402, 874);
      return { path: screenshotPath };
    }
    if (command === 'snapshot') {
      return {
        backend: 'xctest',
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
      };
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
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
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['screenshot', 'snapshot']);
  expect(mockDispatch.mock.calls[1]?.[4]).toMatchObject({
    snapshotInteractiveOnly: true,
  });
  expect(sessionStore.get('default')?.snapshot?.nodes[4]?.type).toBe('Cell');
});

test('screenshot --overlay-refs uses a fresh snapshot instead of stale session snapshot', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
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
  sessionStore.set('default', session);

  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-${Date.now()}.png`);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      writeSolidPng(screenshotPath);
      return { path: screenshotPath };
    }
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeButton',
            label: 'Fresh',
            hittable: true,
            rect: { x: 0, y: 0, width: 40, height: 20 },
          },
        ],
      };
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
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
        overlayRect: { x: 0, y: 0, width: 100, height: 50 },
        center: { x: 50, y: 25 },
      },
    ]);
  }
  expect(sessionStore.get('default')?.snapshot?.nodes[0]?.label).toBe('Fresh');
  const png = PNG.sync.read(fs.readFileSync(screenshotPath));
  expect(Array.from(png.data.slice(0, 4))).not.toEqual([255, 255, 255, 255]);
});

test('screenshot --pixel-density keeps overlay refs aligned to scaled iOS simulator output', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeIosSession('default'));
  const screenshotPath = path.join(os.tmpdir(), `agent-device-overlay-2x-${Date.now()}.png`);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'screenshot') {
      writeSolidPng(screenshotPath, 804, 1748);
      return { path: screenshotPath };
    }
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'Application',
            rect: { x: 0, y: 0, width: 402, height: 874 },
          },
          {
            index: 1,
            type: 'XCUIElementTypeButton',
            label: 'Continue',
            hittable: true,
            rect: { x: 10, y: 20, width: 80, height: 30 },
          },
        ],
      };
    }
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
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

test('screenshot --pixel-density is rejected outside iOS-family simulators', async () => {
  const sessionStore = makeSessionStore('agent-device-router-screenshot-');
  sessionStore.set('default', makeSession('default'));

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

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
  expect(mockDispatch).not.toHaveBeenCalled();
});
