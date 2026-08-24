import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockTapElementSelector,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import { contextFromFlags } from './interaction-touch-fixtures.ts';

// Ordinary selectors stay capture-backed. Only the explicit Maestro
// non-hittable fallback may use the direct iOS selector route.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

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

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/app-lifecycle.ts';
import { getAndroidScreenSize } from '../../../platforms/android/input-actions.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  resetGetRuntimeFixture();
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogFocus.mockReset();
  mockGetAndroidBlockingDialogFocus.mockResolvedValue(null);
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

test('ordinary click uses canonical capture even when the owner binds selector tap', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-selector-without-direct-operation';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  mockCaptureSnapshotForSession.mockResolvedValueOnce({
    nodes: attachRefs([
      {
        index: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        identifier: 'submit',
        rect: { x: 40, y: 80, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    backend: 'xctest',
    producer: 'apple-runner',
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockTapElementSelector).not.toHaveBeenCalled();
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 90, y: 100 } }));
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
    backend: 'xctest',
    producer: 'apple-runner',
  });
  mockFillPoint.mockResolvedValueOnce({
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockFillPoint).toHaveBeenCalledWith(
    expect.objectContaining({
      point: { x: 190, y: 102 },
      text: 'ada@example.com',
      delayMs: 25,
    }),
  );
  expect(mockTapElementSelector).not.toHaveBeenCalled();
  if (response?.ok) {
    expect(response.data?.selector).toBe('id="email"');
    expect(response.data?.text).toBe('ada@example.com');
  }
});

test('click simple iOS selector forwards Maestro non-hittable coordinate fallback', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-maestro-selector-fallback';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockTapElementSelector.mockResolvedValue({
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockTapElementSelector).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: {
        key: 'id',
        value: 'hiddenTestLogin',
        raw: 'id="hiddenTestLogin"',
        allowNonHittableCoordinateFallback: true,
      },
    }),
  );
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

  mockCaptureSnapshotForSession.mockResolvedValue({
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
    producer: 'apple-runner',
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockTapElementSelector).not.toHaveBeenCalled();
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 164, y: 574 } }));
});
