import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { contextFromFlags, makeSession } from './interaction-touch-fixtures.ts';

// What the shared runtime dispatch does with the resolved target: refuse
// unusable frame evidence rather than recapture positionally (ADR 0014), refuse
// off-screen targets, and store the coordinates a lazy outcome retry replays.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

async function withRunner<T>(operation: () => Promise<T>): Promise<T> {
  return await withAppleRunnerProvider(mockRunAppleRunnerCommand, { deviceId: 'sim-1' }, operation);
}

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

test('press @ref stores resolved coordinate retry payload for lazy outcome retry', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'retry-ref';
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
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: { interactionOutcome: { retryOnNoChange: true } },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  const stored = sessionStore.get(sessionName);
  expect(stored?.pendingInteractionOutcome?.command).toBe('press');
  expect(stored?.pendingInteractionOutcome?.positionals).toEqual(['60', '40']);
  expect(stored?.actions[0]?.positionals).toEqual(['@e1']);
  expect(stored?.actions[0]?.flags).toEqual({});
});

test('press @ref fails closed when the authorized ref has no usable bounds (ADR 0014)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-refresh';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockTapPoint.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on missing frame evidence'),
  );

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

  // ADR 0014: the authorized frame's @e1 has no usable rect, so the ref FAILS
  // rather than recapturing and accepting the same index from a newer tree by
  // positional coincidence. No fresh capture, no dispatch.
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/not found or has no bounds/);
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('press @ref fails closed when stored ref bounds are invalid (ADR 0014)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 8 Pro',
    kind: 'emulator',
    booted: true,
  };
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'My App',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockTapPoint.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on unusable frame evidence'),
  );

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

  // ADR 0014: the authorized frame's @e1 has an unusable rect (NaN), so it FAILS
  // rather than recapturing and accepting the same index from a newer tree.
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/not found or has no bounds/);
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('press @ref fails fast when the target is off-screen', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'press-offscreen-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        depth: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Far item',
        rect: { x: 20, y: 1200, width: 120, height: 44 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  const response = await withRunner(() =>
    handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e2'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
      ...getRuntimeBindings(),
    }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockTapPoint).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/off-screen/i);
    // #1366: the hint names the concrete scroll direction, steers to a
    // selector-based retry (a @ref would be rejected as expired after the scroll),
    // and prescribes bounded movement (a large fling scroll overshoots).
    expect(response.error.hint).toMatch(/scroll down/i);
    expect(response.error.hint).toMatch(/selector/i);
    expect(response.error.hint).toMatch(/small steps/i);
    expect(response.error.hint).toMatch(/gesture pan/i);
    expect(response.error.details?.reason).toBe('offscreen_ref');
    expect(response.error.details?.scrollDirection).toBe('down');
  }
});

test('press @ref with a trailing label recovers within the authorized frame (no positional recapture)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel 8 Pro',
    kind: 'emulator',
    booted: true,
  };
  // @e1's rect is unusable, but the SAME frame tree carries another node with
  // the trailing label at usable bounds. ADR 0014 label recovery resolves within
  // the authorized frame — never by recapturing a fresh tree.
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'Different',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        type: 'android.widget.TextView',
        label: 'My App',
        rect: { x: 100, y: 200, width: 80, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockCaptureSnapshotForSession.mockRejectedValue(
    new Error('no positional recapture: recovery stays in-frame'),
  );
  mockTapPoint.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'My App'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 140, y: 220 } }));
  if (response?.ok) {
    expect(response.data?.x).toBe(140);
    expect(response.data?.y).toBe(220);
    expect(response.data?.resolution).toEqual({
      source: 'ref',
      phase: 'pre-action',
      kind: 'label-fallback',
    });
  }
});
