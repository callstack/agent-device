import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import { contextFromFlags, makeAndroidSession } from './interaction-touch-fixtures.ts';

// The Android ref-refresh capture a @ref mutation takes before dispatch: when
// it runs, what it may not retarget, and the comparison-safe baseline it hands
// finalization when the refresh fails.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return { ...actual, getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })) };
});

vi.mock('../../../platforms/android/window-state.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/window-state.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
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
  getAndroidBlockingDialogObservation,
} from '../../../platforms/android/window-state.ts';
import { getAndroidScreenSize } from '../../../platforms/android/input-actions.ts';
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

test('press @ref refreshes Android snapshot when freshness tracking is active', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-refresh';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 40, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 100, y: 200, width: 80, height: 40 },
        enabled: true,
        hittable: true,
      },
    ],
    backend: 'android',
    producer: 'android-uiautomator',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'Continue'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockCaptureSnapshotForSession.mock.calls[0]?.[0].options).toMatchObject({
    interactiveOnly: true,
  });
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 140, y: 220 } }));
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 1,
    routeComparable: true,
  });
});

test('ADR 0014: Android freshness cannot retarget an admitted ref by positional coincidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-no-retarget';
  const session = makeAndroidSession(sessionName);
  const frameTree = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 40, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android' as const,
    comparisonSafe: true,
  };
  session.snapshot = frameTree;
  // ADR 0014: the authorized frame tree names WHICH node @e1 authorizes.
  session.refFrameTree = frameTree;
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  // The freshness refresh returns a DIFFERENT element at @e1's index — after
  // navigation the button at that position is now "Cancel", not "Continue".
  mockCaptureSnapshotForSession.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Cancel',
        rect: { x: 100, y: 200, width: 80, height: 40 },
        enabled: true,
        hittable: true,
      },
    ],
    backend: 'android',
    producer: 'android-uiautomator',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  // The identity at @e1 changed (Continue -> Cancel), so the refreshed
  // observation must NOT redefine the target: the press stays on the frame
  // node's coordinates (center of {0,0,40,40}), never the fresh (140, 220).
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 20, y: 20 } }));
});

test('press @ref falls back to cached Android ref when freshness refresh fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-refresh-failure';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockCaptureSnapshotForSession.mockRejectedValueOnce(new Error('uiautomator timeout'));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'Continue'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 60, y: 40 } }));
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 1,
    routeComparable: true,
  });
});

test('coordinate press preserves Android route freshness from last comparable snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-coordinate-freshness-baseline';
  const session = makeAndroidSession(sessionName);
  const comparableSnapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.ScrollView',
        label: 'Albums',
        rect: { x: 0, y: 0, width: 400, height: 700 },
      },
      {
        index: 1,
        type: 'android.widget.Button',
        label: 'Go to Contacts',
        rect: { x: 16, y: 120, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android' as const,
    comparisonSafe: true,
  };
  session.lastComparisonSafeSnapshot = comparableSnapshot;
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Go to Contacts',
        rect: { x: 16, y: 120, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: false,
  };
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['96', '144'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 2,
    baselineSignatures: expect.any(Array),
    routeComparable: true,
  });
});
