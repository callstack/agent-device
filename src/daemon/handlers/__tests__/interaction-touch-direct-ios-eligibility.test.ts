import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  contextFromFlags,
  createEmulateCaptureSnapshotForSession,
} from './interaction-touch-fixtures.ts';

// Whether a click may take the direct iOS selector fast path: which selector
// shapes qualify, what Maestro decoration rides along, and the exclusions that
// keep a capture-backed guarantee (fill, pending stabilization).

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

test('click simple iOS id selector uses direct runner selector tap without snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockResolvedValue({
    message: 'tapped',
    x: 80,
    y: 100,
    referenceWidth: 390,
    referenceHeight: 844,
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect(pressCalls[0]?.[2]).toEqual([]);
  expect((pressCalls[0]?.[4] as Record<string, unknown>)?.directElementSelector).toEqual({
    key: 'id',
    value: 'submit',
    raw: 'id="submit"',
  });
  if (response?.ok) {
    expect(response.data?.selector).toBe('id="submit"');
  }
});

test('fill simple iOS id selector resolves runtime text input evidence before coordinate fill', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-runtime-selector-fill';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockCaptureSnapshotForSession.mockResolvedValueOnce({
    nodes: attachRefs([
      {
        index: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 440, height: 956 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'TextField',
        identifier: 'email',
        label: 'Email',
        rect: { x: 40, y: 80, width: 300, height: 44 },
        enabled: true,
        hittable: false,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  });
  mockDispatch.mockResolvedValueOnce({
    message: 'filled',
    x: 190,
    y: 102,
    referenceWidth: 440,
    referenceHeight: 956,
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['id="email"', 'ada@example.com'],
      flags: { delayMs: 25 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('fill');
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['190', '102', 'ada@example.com']);
  const context = mockDispatch.mock.calls[0]?.[4] as Record<string, unknown>;
  expect(context.directElementSelector).toBeUndefined();
  expect(context.delayMs).toBe(25);
  if (response?.ok) {
    expect(response.data?.selector).toBe('id="email"');
    expect(response.data?.text).toBe('ada@example.com');
  }
});

test('click simple iOS selector forwards Maestro non-hittable coordinate fallback', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-selector-fallback';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockResolvedValue({
    message: 'tapped via non-hittable coordinate fallback',
    maestroNonHittableCoordinateFallbackUsed: true,
    x: 439.5,
    y: 101.5,
    referenceWidth: 440,
    referenceHeight: 956,
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="hiddenTestLogin"'],
      flags: { maestro: { allowNonHittableCoordinateFallback: true } },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect((pressCalls[0]?.[4] as Record<string, unknown>)?.directElementSelector).toEqual({
    key: 'id',
    value: 'hiddenTestLogin',
    raw: 'id="hiddenTestLogin"',
    allowNonHittableCoordinateFallback: true,
  });
  if (response?.ok) {
    expect(response.data?.maestroNonHittableCoordinateFallbackAllowed).toBe(true);
    expect(response.data?.maestroNonHittableCoordinateFallbackUsed).toBe(true);
    expect(response.data?.maestroFallbackReason).toBe('non-hittable-coordinate');
  }
});

test('click simple iOS id selector waits for snapshot path after pending gesture stabilization', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-after-swipe';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.postGestureStabilization = { action: 'swipe', positionals: [], markedAt: Date.now() };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    if (command === 'snapshot') {
      return {
        nodes: attachRefs([
          {
            index: 0,
            type: 'Window',
            rect: { x: 0, y: 0, width: 390, height: 844 },
          },
          {
            index: 1,
            parentIndex: 0,
            type: 'XCUIElementTypeButton',
            identifier: 'shipping-pickup',
            rect: { x: 126, y: 555, width: 75, height: 38 },
            enabled: true,
            hittable: true,
          },
        ]),
        backend: 'xctest',
      };
    }
    if (command === 'press') {
      return { x: Number(positionals[0]), y: Number(positionals[1]), pressed: true };
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['id="shipping-pickup"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  expect((pressCalls[0]?.[4] as Record<string, unknown>)?.directElementSelector).toBeUndefined();
  expect(pressCalls[0]?.[2]).toEqual(['164', '574']);
});
