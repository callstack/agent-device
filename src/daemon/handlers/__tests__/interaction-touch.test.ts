import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockHoverPoint,
  mockHoverRef,
  mockLongPressPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
  runtimeBindingSpies,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeMacOsDesktopSession,
  makeMacOsMenubarSession,
  makeSession,
} from './interaction-touch-fixtures.ts';

// Router ownership: one representative per touch command proves
// handleTouchInteractionCommands claims press/click/longpress/hover/fill.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })),
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('@agent-device/platform-apple', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-apple')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  getAndroidScreenSize,
} from '@agent-device/platform-android/mechanics';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogObservation = vi.mocked(getAndroidBlockingDialogObservation);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  resetGetRuntimeFixture();
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogObservation.mockReset();
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'clear' });
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

test('press coordinates dispatches press and records as press', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const storedSession = makeSession(sessionName);
  sessionStore.set(sessionName, storedSession);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['100', '200'],
      flags: { count: 3, intervalMs: 1, doubleTap: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledOnce();
  expect(mockTapPoint.mock.calls[0]?.[0]).toMatchObject({
    point: { x: 100, y: 200 },
    options: { count: 3, intervalMs: 1, doubleTap: true },
  });

  const session = sessionStore.get(sessionName);
  expect(session).toBeTruthy();
  expect(session?.actions.length).toBe(1);
  expect(session?.actions[0]?.command).toBe('press');
  expect(session?.actions[0]?.positionals).toEqual(['100', '200']);
});

test.each([
  ['click', ['100', '200'], false],
  ['press', ['100', '200'], false],
  ['longpress', ['100', '200', '800'], false],
  ['hover', ['100', '200'], true],
  ['fill', ['100', '200', 'hello'], false],
] as const)('%s inspects once and binds once', async (command, positionals, web) => {
  const sessionStore = makeSessionStore();
  const sessionName = `single-bind-${command}`;
  const session = makeSession(sessionName);
  if (web) session.device = WEB_DESKTOP_DEVICE;
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: { token: 't', session: sessionName, command, positionals: [...positionals], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(runtimeBindingSpies().inspectFacts).toHaveBeenCalledOnce();
  expect(runtimeBindingSpies().bindDevice).toHaveBeenCalledOnce();
});

test('click rejects macOS desktop surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-desktop-click';
  sessionStore.set(sessionName, makeMacOsDesktopSession(sessionName));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['100', '200'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/macOS desktop sessions/);
  }
});

test('fill rejects macOS menubar surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-menubar-fill';
  sessionStore.set(sessionName, makeMacOsMenubarSession(sessionName));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e2', 'hello'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/macOS menubar sessions/);
  }
});

test('longpress @ref resolves the target and dispatches coordinate longpress', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'longpress-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeStaticText',
        label: 'Last message',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'longpress',
      positionals: ['@e1', '800'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(60);
    expect(response.data?.y).toBe(40);
    expect(response.data?.durationMs).toBe(800);
    expect(response.data?.message).toMatch(/Long pressed @e1/);
  }
  expect(mockLongPressPoint).toHaveBeenCalledWith(
    expect.objectContaining({ point: { x: 60, y: 40 }, durationMs: 800 }),
  );
  expect(sessionStore.get(sessionName)?.actions[0]?.command).toBe('longpress');
});

// #1783: hover is the pointer-only member of the targeted-touch family. It rides
// the same admission path as press/longpress, and only web admits it. On web
// the session's ref frame is minted WITHOUT rects (snapshot -i does not fetch
// boxes), so `hover @ref` cannot resolve to coordinates: like `click @ref` it
// must take the provider-native route (`hoverRef`, ADR 0011 native-ref path).
// This test therefore stores a rect-less web frame and a scoped provider — the
// production shape — and asserts no coordinate dispatch happens.
test('hover @ref on web dispatches through the provider hoverRef route, not coordinates', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'hover-ref';
  const session = makeSession(sessionName);
  session.device = WEB_DESKTOP_DEVICE;
  session.snapshot = {
    nodes: attachRefs([{ index: 0, role: 'link', label: 'Second message', enabled: true }]),
    createdAt: Date.now(),
    backend: 'web',
  };
  sessionStore.set(sessionName, session);
  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'hover',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({
    ok: true,
    data: { ref: 'e1', gesture: 'hover', message: expect.stringMatching(/Hovered @e1/) },
  });
  expect(mockHoverRef).toHaveBeenCalledWith(expect.objectContaining({ ref: '@e1' }));
  expect(sessionStore.get(sessionName)?.actions[0]?.command).toBe('hover');
});

test('hover selector on web resolves the target and dispatches coordinate hover', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'hover-selector';
  const session = makeSession(sessionName);
  session.device = WEB_DESKTOP_DEVICE;
  sessionStore.set(sessionName, session);
  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: attachRefs([
      {
        index: 0,
        role: 'link',
        label: 'Second message',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    backend: 'web',
    producer: 'agent-browser',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'hover',
      positionals: ['label="Second message"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({
    ok: true,
    data: { x: 60, y: 40, gesture: 'hover', message: expect.stringMatching(/Hovered label/) },
  });
  expect(mockHoverPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 60, y: 40 } }));
});

test('hover is refused by capability on touch platforms before any dispatch', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'hover-ios';
  sessionStore.set(sessionName, makeSession(sessionName));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'hover',
      positionals: ['100', '200'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'hover is not supported on this device',
      hint: 'hover raises pointer hover state and is available on web targets only. On touch platforms use longpress for hold gestures.',
    },
  });
});
