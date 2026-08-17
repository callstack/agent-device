import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import { withWebProvider, type WebProvider } from '../../../platforms/web/provider.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  contextFromFlags,
  createEmulateCaptureSnapshotForSession,
  makeMacOsDesktopSession,
  makeMacOsMenubarSession,
  makeSession,
} from './interaction-touch-fixtures.ts';

// Router ownership: one representative per touch command proves
// handleTouchInteractionCommands claims press/click/longpress/hover/fill.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return { ...actual, getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })) };
});

vi.mock('../../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

vi.mock('../interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({
      nodes: [],
      createdAt: 0,
      backend: 'xctest' as const,
    })),
  };
});

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/app-lifecycle.ts';
import { getAndroidScreenSize } from '../../../platforms/android/input-actions.ts';
import { captureSnapshotForSession } from '../interaction-snapshot.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogFocus.mockReset();
  mockGetAndroidBlockingDialogFocus.mockResolvedValue(null);
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(
    createEmulateCaptureSnapshotForSession(mockDispatch),
  );
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

test('press coordinates dispatches press and records as press', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const storedSession = makeSession(sessionName);
  sessionStore.set(sessionName, storedSession);

  mockDispatch.mockResolvedValue({ ok: true });

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
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('press');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['100', '200']);
  const context = mockDispatch.mock.calls[0]?.[4] as Record<string, unknown> | undefined;
  expect(context?.count).toBe(3);
  expect(context?.intervalMs).toBe(1);
  expect(context?.doubleTap).toBe(true);

  const session = sessionStore.get(sessionName);
  expect(session).toBeTruthy();
  expect(session?.actions.length).toBe(1);
  expect(session?.actions[0]?.command).toBe('press');
  expect(session?.actions[0]?.positionals).toEqual(['100', '200']);
});

test('click rejects macOS desktop surface interactions until helper routing exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-desktop-click';
  sessionStore.set(sessionName, makeMacOsDesktopSession(sessionName));

  mockDispatch.mockRejectedValue(new Error('dispatch should not be called'));

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

  mockDispatch.mockRejectedValue(new Error('dispatch should not be called'));

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

  mockDispatch.mockResolvedValue({ native: true });

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
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.x).toBe(60);
    expect(response.data?.y).toBe(40);
    expect(response.data?.durationMs).toBe(800);
    expect(response.data?.message).toMatch(/Long pressed @e1/);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('longpress');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['60', '40', '800']);
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
  const hoveredRefs: string[] = [];
  const provider = makeWebProvider({
    hoverRef: async (ref) => {
      hoveredRefs.push(ref);
    },
  });

  const response = await withWebProvider(provider, async () =>
    handleInteractionCommands({
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
    }),
  );

  expect(response).toMatchObject({
    ok: true,
    data: { ref: 'e1', gesture: 'hover', message: expect.stringMatching(/Hovered @e1/) },
  });
  expect(hoveredRefs).toEqual(['@e1']);
  expect(mockDispatch).not.toHaveBeenCalled();
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
    createdAt: Date.now(),
    backend: 'web',
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
  });

  expect(response).toMatchObject({
    ok: true,
    data: { x: 60, y: 40, gesture: 'hover', message: expect.stringMatching(/Hovered label/) },
  });
  expect(mockDispatch.mock.calls).toEqual([
    [expect.anything(), 'hover', ['60', '40'], undefined, expect.anything()],
  ]);
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
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringMatching(/--platform web/),
    },
  });
  expect(mockDispatch).not.toHaveBeenCalled();
});

function makeWebProvider(overrides: Partial<WebProvider>): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}
