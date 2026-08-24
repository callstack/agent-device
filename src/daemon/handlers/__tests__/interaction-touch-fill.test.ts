import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { activateCompleteRefFrame, expireRefFrame } from '../../ref-frame.ts';
import { STALE_SNAPSHOT_REFS_WARNING } from '../../session-snapshot.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeSession,
  makeStaleRefSession,
  runInteraction,
} from './interaction-touch-fixtures.ts';

// How fill is admitted and projected: its @ref admission and pins, the editable
// node it keeps, and the guards that refuse before typing.

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

test('fill @ref fails fast when the target is off-screen', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'fill-offscreen-ref';
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
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 20, y: 1180, width: 180, height: 44 },
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
      command: 'fill',
      positionals: ['@e2', 'hello@example.com'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockFillPoint).not.toHaveBeenCalled();
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/off-screen/i);
    // #1366: direction-named, selector-first recovery hint (see press test above).
    expect(response.error.hint).toMatch(/scroll down/i);
    expect(response.error.hint).toMatch(/selector/i);
    expect(response.error.details?.reason).toBe('offscreen_ref');
    expect(response.error.details?.scrollDirection).toBe('down');
  }
});

test('fill @ref fails closed when stored ref bounds are invalid (ADR 0014)', async () => {
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
        type: 'android.widget.EditText',
        label: 'Email',
        rect: { x: 20, y: 40, width: Number.NaN, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockFillPoint.mockRejectedValue(
    new Error('dispatch must not run: no positional recapture on unusable frame evidence'),
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello@example.com'],
      flags: { delayMs: 25 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  // ADR 0014: the authorized frame's @e1 has an unusable rect, so the fill FAILS
  // rather than recapturing a fresh tree and filling the same index.
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/not found or has no bounds/);
  }
  expect(mockFillPoint).not.toHaveBeenCalled();
});

test('fill @ref rejects after a device action expired the frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-fill';
  const session = makeStaleRefSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  // ADR 0014: an unobserved device action expired the frame.
  expireRefFrame(session);
  sessionStore.set(sessionName, session);
  mockFillPoint.mockRejectedValue(
    new Error('dispatch should not be called for an expired-frame ref'),
  );

  const response = await runInteraction(sessionStore, sessionName, 'fill', [
    '@e1',
    'hello@example.com',
  ]);
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/expired ref frame/);
    expect(response.error.details?.reason).toBe('ref_frame_expired');
    expect(response.error.details?.hint).toBe(STALE_SNAPSHOT_REFS_WARNING);
  }
  expect(mockFillPoint).not.toHaveBeenCalled();
});

test('fill with a pinned stale ref rejects; pinned current is clean', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'pinned-fill';
  const session = makeStaleRefSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.snapshotGeneration = 3;
  // Re-issue the frame over the overridden snapshot so its source tree matches.
  activateCompleteRefFrame(session);
  sessionStore.set(sessionName, session);

  const stale = await runInteraction(sessionStore, sessionName, 'fill', ['@e1~s2', 'hello']);
  expect(stale?.ok).toBe(false);
  if (stale && !stale.ok) {
    expect(stale.error.code).toBe('COMMAND_FAILED');
    expect(stale.error.details?.hint).toBe(
      "Ref @e1 was minted from snapshot s2 but the session's ref frame is now s3 — re-run snapshot -i.",
    );
  }
  expect(mockFillPoint).not.toHaveBeenCalled();

  const current = await runInteraction(sessionStore, sessionName, 'fill', ['@e1~s3', 'hello']);
  expect(current?.ok).toBe(true);
  if (current?.ok) {
    expect(current.data?.warning).toBeUndefined();
  }
});

test("ADR 0014 blocker-2: a mutating find's internal fill from an expired frame carries no stale-ref warning", async () => {
  // Removing the coarse marker (step 8) means an expired frame now derives read
  // staleness. A mutating `find fill` re-resolves the locator itself and re-enters
  // the fill leaf with a LOCATOR-minted ref (`internal.findResolvedTarget`) — the
  // caller never consumed a `@ref`, so the public find response must not claim
  // stale refs even though the frame is expired.
  const sessionStore = makeSessionStore();
  const sessionName = 'find-internal-fill-expired';
  const session = makeStaleRefSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  // Re-issue the frame over the overridden snapshot, then expire it as if a prior
  // device side effect changed the screen.
  activateCompleteRefFrame(session);
  expireRefFrame(session);
  sessionStore.set(sessionName, session);
  mockFillPoint.mockResolvedValue({ filled: true });

  // Contrast: a user-supplied `@ref` against the expired frame rejects before
  // dispatch (it consumed a stale ref).
  const userRef = await runInteraction(sessionStore, sessionName, 'fill', ['@e1', 'hello']);
  expect(userRef?.ok).toBe(false);
  if (userRef && !userRef.ok) {
    expect(userRef.error.details?.reason).toBe('ref_frame_expired');
  }

  // The mutating find's internal dispatch (the exact request find.ts hands the
  // leaf) bypasses admission AND attaches no stale-ref warning.
  const findNodes = session.snapshot.nodes;
  const findNode = findNodes[0]!;
  const internal = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello'],
      flags: {},
      internal: {
        findResolvedTarget: { ref: '@e1', node: findNode, nodes: findNodes },
      },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  expect(internal?.ok).toBe(true);
  if (internal?.ok) {
    expect(internal.data?.warning).toBeUndefined();
  }
});

test('fill @ref keeps the original editable node when its parent is the hittable ancestor', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeCell',
        label: 'Email row',
        rect: { x: 20, y: 100, width: 320, height: 72 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'auth_email',
        rect: { x: 44, y: 120, width: 200, height: 32 },
        enabled: true,
        hittable: false,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockFillPoint.mockResolvedValue({ filled: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e2', 'hello@example.com'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockFillPoint).toHaveBeenCalledWith(
    expect.objectContaining({
      point: { x: 144, y: 136 },
      text: 'hello@example.com',
    }),
  );

  const stored = sessionStore.get(sessionName);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.ref).toBe('e2');
});
