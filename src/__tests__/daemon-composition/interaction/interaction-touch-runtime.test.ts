import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { withAppleRunnerProvider } from '@agent-device/platform-apple/runner';
import { makeSessionStore } from '../../../daemon/__tests__/support/store-factory.ts';
import { handleInteractionCommands } from '../../../daemon/interaction/index.ts';
import {
  elementReadFixtureState,
  getRuntimeBindings,
  mockQuerySelector,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../daemon/__tests__/interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeSession,
} from '../../../daemon/interaction/internal/__tests__/interaction-touch-fixtures.ts';
import { testCreateCommandSurface } from '../command-surface-fixture.ts';

// What the shared runtime dispatch does with the resolved target: refuse
// unusable frame evidence rather than recapture positionally (ADR 0014), refuse
// off-screen targets, and record the `@ref` the caller wrote.

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

vi.mock('../../../daemon/snapshot-interactor-capture.ts', () => ({
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
import { captureSnapshotWithInteractor } from '../../../daemon/snapshot-interactor-capture.ts';
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

test('press @ref taps the resolved point once and records the ref', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'press-ref';
  const session = makeSession(sessionName);
  const nodes = attachRefs([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      identifier: 'auth_continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      enabled: true,
      hittable: true,
    },
  ]);
  session.snapshot = { nodes, createdAt: Date.now(), backend: 'xctest' };
  sessionStore.publish(sessionName, session);

  const response = await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
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
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0]?.point).toEqual({ x: 60, y: 40 });
  const stored = sessionStore.get(sessionName);
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
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on missing frame evidence'),
  );

  const response = await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
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
    expect(response.error.message).toMatch(/Ref @e1 has no usable bounds/);
    expect(response.error.details).toMatchObject({ reason: 'target_bounds_invalid', ref: 'e1' });
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
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on unusable frame evidence'),
  );

  const response = await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
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
    expect(response.error.message).toMatch(/Ref @e1 has no usable bounds/);
    expect(response.error.details).toMatchObject({ reason: 'target_bounds_invalid', ref: 'e1' });
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
});

// #1542 wiring, daemon route: the off-screen rescue's live read rides the SAME request-bound
// binding the touch command was admitted for. These two tests pin both declared sides of the
// CONDITIONAL `querySelector` fact: an owner that advertises it answers the guard with a live
// rect the tap lands on; an owner that does not refuses on the bulk-tree verdict with ZERO
// queries. Deleting `conditional: ['querySelector']` from the captured touch uses, or making the
// rescue hook return undefined, breaks one of these two; the Apple binding's own spread is pinned
// in platform-apple's runtime.test.ts.

const RESCUE_ROUTE_SESSION = 'rescue-route';

function offscreenRefSessionStore() {
  const sessionStore = makeSessionStore();
  const session = makeSession(RESCUE_ROUTE_SESSION);
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
        identifier: 'far_item',
        rect: { x: 20, y: 1200, width: 120, height: 44 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.publish(RESCUE_ROUTE_SESSION, session);
  return sessionStore;
}

async function pressOffscreenRef(sessionStore: ReturnType<typeof makeSessionStore>) {
  return await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
    req: {
      token: 't',
      session: RESCUE_ROUTE_SESSION,
      command: 'press',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName: RESCUE_ROUTE_SESSION,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

test('press @ref an off-screen node is rescued to the live rect when the owner advertises querySelector', async () => {
  const sessionStore = offscreenRefSessionStore();
  elementReadFixtureState.querySelectorAvailable = true;
  mockQuerySelector.mockResolvedValue({
    found: true,
    node: { rect: { x: 20, y: 400, width: 120, height: 44 }, hittable: true },
  });

  const response = await pressOffscreenRef(sessionStore);

  // The rescue wins: the press lands at the CENTER OF THE LIVE RECT, not the stale
  // bulk-tree row's off-screen geometry, and the live read carried the derived selector.
  expect(response?.ok).toBe(true);
  expect(mockQuerySelector).toHaveBeenCalledTimes(1);
  expect(mockQuerySelector.mock.calls[0]?.[0].selector).toEqual({
    key: 'id',
    value: 'far_item',
  });
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0]?.point).toEqual({ x: 80, y: 422 });
});

test('press @ref an off-screen node refuses with zero queries when the owner does not advertise querySelector', async () => {
  // The fixture default: the owner's facts declare the CONDITIONAL read unavailable, so the
  // route holds no hook and the guard's refusal is built from the bulk tree alone.
  const sessionStore = offscreenRefSessionStore();

  const response = await pressOffscreenRef(sessionStore);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details?.reason).toBe('offscreen_ref');
  }
  expect(mockQuerySelector).not.toHaveBeenCalled();
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
  sessionStore.publish(sessionName, session);

  const response = await withRunner(() =>
    handleInteractionCommands({
      createCommandSurface: testCreateCommandSurface,
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
    // #1366: the hint names the concrete scroll direction and steers to a selector-based retry
    // (a @ref would be rejected as expired after the scroll). A ref refusal has no selector to
    // check between passes, so this hint names the move and leaves the stop condition to the
    // selector retry it prescribes.
    expect(response.error.hint).toMatch(/scroll down/i);
    expect(response.error.hint).toMatch(/selector/i);
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
  sessionStore.publish(sessionName, session);

  mockCaptureSnapshotForSession.mockRejectedValue(
    new Error('no positional recapture: recovery stays in-frame'),
  );
  mockTapPoint.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
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
