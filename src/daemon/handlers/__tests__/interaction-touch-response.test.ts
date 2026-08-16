import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  contextFromFlags,
  installTestScreenRecording,
  makeSession,
} from './interaction-touch-fixtures.ts';

// The identity extras the one response site composes: --verify evidence rides
// the interactionResultExtra allowlist on every branch, and no branch invents
// an evidence field without it.

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

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

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
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
import { captureSnapshotThroughLegacyDispatchFixture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotWithInteractor);

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
  mockCaptureSnapshotForSession.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

test('press @ref --verify surfaces evidence through the interactionResultExtra allowlist', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'verify-press';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      // Post-action capture reports an extra node, so changedFromBefore should
      // read true against the pre-action (stored) snapshot's single node.
      return {
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeButton',
            label: 'Continue',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
          {
            index: 1,
            type: 'XCUIElementTypeStaticText',
            label: 'Loaded',
            rect: { x: 10, y: 80, width: 100, height: 20 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'xctest',
      };
    }
    return { pressed: true };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: { verify: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    const evidence = response.data?.evidence as
      | {
          nodeCount: number;
          interactiveNodeCount: number;
          digest: string;
          changedFromBefore: boolean;
        }
      | undefined;
    expect(evidence).toBeTruthy();
    expect(evidence?.nodeCount).toBe(2);
    expect(evidence?.interactiveNodeCount).toBe(2);
    expect(typeof evidence?.digest).toBe('string');
    expect(evidence?.changedFromBefore).toBe(true);
  }
  // The stored ref snapshot already had a valid rect, so resolution reused it
  // without a fresh pre-action capture (zero extra cost, per #1047's design) —
  // only the post-action verify capture issues a 'snapshot' dispatch, after 'press'.
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['press', 'snapshot']);
});

test('press @ref without --verify never includes an evidence field', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'no-verify-press';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({ pressed: true });

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
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.evidence).toBeUndefined();
  }
  // No verify flag means no post-action snapshot capture at all.
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['press']);
});

test('fill selector --verify surfaces evidence through the interactionResultExtra allowlist', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'verify-fill';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeTextField',
            label: 'Email',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'xctest',
      };
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['label=Email', 'hello@example.com'],
      flags: { verify: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    const evidence = response.data?.evidence as
      | { nodeCount: number; changedFromBefore: boolean }
      | undefined;
    expect(evidence).toBeTruthy();
    expect(evidence?.nodeCount).toBe(1);
    // Same node set before and after, so no change is reported.
    expect(evidence?.changedFromBefore).toBe(false);
  }
});

test('fill @ref --verify surfaces evidence in the ref response branch', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'verify-fill-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeTextField',
            label: 'Email',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
          {
            index: 1,
            type: 'XCUIElementTypeButton',
            label: 'Submit',
            rect: { x: 10, y: 80, width: 100, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'xctest',
      };
    }
    return {};
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello@example.com'],
      flags: { verify: true },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    const evidence = response.data?.evidence as
      | { nodeCount: number; changedFromBefore: boolean; digest: string }
      | undefined;
    expect(evidence).toBeTruthy();
    expect(evidence?.nodeCount).toBe(2);
    expect(evidence?.changedFromBefore).toBe(true);
    expect(typeof evidence?.digest).toBe('string');
  }
});

test('fill @ref without --verify never includes an evidence field', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'no-verify-fill-ref';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({});

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello@example.com'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.evidence).toBeUndefined();
  }
  // No verify flag means no post-action snapshot capture at all.
  expect(mockDispatch.mock.calls.map((call) => call[1])).not.toContain('snapshot');
});

test('fill @ref preserves fallback coordinates for recording when platform result is sparse', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'auth_email',
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
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ filled: true });
  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello@example.com'],
      flags: { delayMs: 55 },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.filled).toBe(true);
  }

  const stored = sessionStore.get(sessionName);
  expect(stored).toBeTruthy();
  const fillCalls = mockDispatch.mock.calls.filter((c) => c[1] === 'fill');
  expect(fillCalls.length).toBe(1);
  expect((fillCalls[0]?.[4] as Record<string, unknown> | undefined)?.delayMs).toBe(55);
  const result = (stored?.actions[0]?.result ?? {}) as Record<string, unknown>;
  expect(result.ref).toBe('e1');
  expect(result.x).toBe(60);
  expect(result.y).toBe(40);
  expect(Array.isArray(result.selectorChain)).toBe(true);

  const event = stored?.screenRecording?.handle.inspect().gestureEvents[0];
  expect(event?.kind).toBe('tap');
  expect(event?.x).toBe(60);
  expect(event?.y).toBe(40);
});
