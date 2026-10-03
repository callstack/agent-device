import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  installTestScreenRecording,
  makeAndroidSession,
  makeSession,
} from './interaction-touch-fixtures.ts';

// What a built touch payload carries: the recorded action entry and touch
// visualization, the coordinates and reference frame each platform resolves,
// and the native timing the recorded result preserves.

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

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  getAndroidScreenSize,
} from '@agent-device/platform-android/mechanics';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
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

// fallow-ignore-next-line complexity
test('press coordinates appends touch-visualization events while recording', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeApplication',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  installTestScreenRecording(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  sessionStore.set(sessionName, session);

  mockTapPoint.mockResolvedValue({
    ok: true,
    videoPath: '/tmp/demo.mp4',
    artifactUri: 'agent-device://artifacts/demo.mp4',
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['100', '200'],
      flags: { count: 2, intervalMs: 150, doubleTap: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  const recorded = sessionStore.get(sessionName)?.screenRecording?.handle.inspect();
  expect(recorded).toBeTruthy();
  expect(recorded?.gestureEvents.length).toBe(4);
  expect(recorded?.gestureEvents[0]?.kind).toBe('tap');
  expect(recorded?.gestureEvents[0]?.x).toBe(100);
  expect(recorded?.gestureEvents[0]?.y).toBe(200);
  expect(recorded?.gestureEvents[0]?.referenceWidth).toBe(402);
  expect(recorded?.gestureEvents[0]?.referenceHeight).toBe(874);
  const actionResult = sessionStore.get(sessionName)?.actions[0]?.result;
  expect(actionResult?.videoPath).toBe('/tmp/demo.mp4');
  expect(actionResult?.artifactUri).toBe('agent-device://artifacts/demo.mp4');
  if (response?.ok) {
    expect(response.data?.videoPath).toBe('/tmp/demo.mp4');
    expect(response.data?.artifactUri).toBe('agent-device://artifacts/demo.mp4');
  }
});

test('press coordinates on iOS recording captures a full snapshot for the touch reference frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-press-frame';
  const session = makeSession(sessionName);
  session.snapshot = undefined;
  installTestScreenRecording(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  sessionStore.set(sessionName, session);

  mockTapPoint.mockResolvedValue({ x: 220, y: 600 });
  // Regression: a filtered snapshot has no Application/Window node, so viewport inference would
  // return a leaf-element bounding box and the recording overlay would misplace tap markers.
  mockCaptureSnapshotForSession.mockResolvedValueOnce({
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeApplication',
        rect: { x: 0, y: 0, width: 440, height: 956 },
      },
      {
        index: 1,
        type: 'XCUIElementTypeCell',
        rect: { x: 16, y: 156, width: 370, height: 52 },
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
      command: 'press',
      positionals: ['220', '600'],
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
  const event = sessionStore.get(sessionName)?.screenRecording?.handle.inspect().gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.referenceWidth).toBe(440);
  expect(event?.referenceHeight).toBe(956);
});

test('press coordinates on Android recording uses physical screen size when no snapshot exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-frame';
  const session = makeAndroidSession(sessionName);
  installTestScreenRecording(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockTapPoint.mockResolvedValue({ x: 300, y: 2300 });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  const event = sessionStore.get(sessionName)?.screenRecording?.handle.inspect().gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.referenceWidth).toBe(1344);
  expect(event?.referenceHeight).toBe(2992);
});

test('press coordinates on Android recording caches physical screen size across interactions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-frame-cache';
  const session = makeAndroidSession(sessionName);
  installTestScreenRecording(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockTapPoint.mockResolvedValue({ x: 300, y: 2300 });

  await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  mockTapPoint.mockResolvedValue({ x: 320, y: 2200 });

  await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['320', '2200'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(mockGetAndroidScreenSize).toHaveBeenCalledTimes(1);
  const recording = sessionStore.get(sessionName)?.screenRecording?.handle.inspect();
  expect(recording?.touchReferenceFrame).toEqual({
    referenceWidth: 1344,
    referenceHeight: 2992,
  });
});

test('press coordinates without recording skips Android screen-size lookup', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-no-recording';
  const session = makeAndroidSession(sessionName);
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockTapPoint.mockResolvedValue({ x: 300, y: 2300 });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockGetAndroidScreenSize).not.toHaveBeenCalled();
});

test('press coordinates during recording still dispatches when Android screen-size lookup fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-direct-press-screen-size-failure';
  const session = makeAndroidSession(sessionName);
  installTestScreenRecording(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  session.snapshot = undefined;
  sessionStore.set(sessionName, session);

  mockTapPoint.mockResolvedValue({ x: 300, y: 2300 });
  mockGetAndroidScreenSize.mockRejectedValue(new Error('adb unavailable'));

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['300', '2300'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  const event = sessionStore.get(sessionName)?.screenRecording?.handle.inspect().gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.x).toBe(300);
  expect(event?.y).toBe(2300);
  expect(event?.referenceWidth).toBeUndefined();
  expect(event?.referenceHeight).toBeUndefined();
});

test('press @ref preserves native timing in recorded result and touch visualization', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  installTestScreenRecording(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: 1_000,
    showTouches: true,
  });
  sessionStore.set(sessionName, session);

  const originalNow = Date.now;
  let now = 1_500;
  Date.now = () => now;

  try {
    mockTapPoint.mockImplementation(async () => {
      now = 1_650;
      return {
        gestureStartUptimeMs: 5_100,
        gestureEndUptimeMs: 5_180,
      };
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
  } finally {
    Date.now = originalNow;
  }

  const stored = sessionStore.get(sessionName);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.gestureStartUptimeMs).toBe(5_100);
  expect(result.gestureEndUptimeMs).toBe(5_180);
  expect(stored?.screenRecording?.handle.inspect().gestureEvents[0]?.tMs).toBe(570);
});
