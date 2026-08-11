import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  contextFromFlags,
  createEmulateCaptureSnapshotForSession,
  makeStaleRefSession,
  makeTwoButtonNodes,
  runInteraction,
} from './interaction-touch-fixtures.ts';

// The direct iOS selector fast path: when it is eligible, what it dispatches,
// when it delegates back to the runtime tree path, and its fused ADR 0014 seam.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
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
  return {
    ...actual,
    runAppleRunnerCommand: mockRunAppleRunnerCommand,
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
const mockDispatch = vi.mocked(dispatchCommand);
import { captureSnapshotForSession } from '../interaction-snapshot.ts';
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
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

test('click simple iOS id selector falls back to snapshot coordinates on transport failure', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-fallback-transport';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
      throw new AppError('COMMAND_FAILED', 'fetch failed');
    }
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
            identifier: 'submit',
            rect: { x: 20, y: 80, width: 120, height: 40 },
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
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(2);
  expect(pressCalls[0]?.[2]).toEqual([]);
  expect(pressCalls[1]?.[2]).toEqual(['80', '100']);
  if (response?.ok) {
    expect(response.data?.selectorChain).toContain('id="submit"');
  }
});

test('click simple iOS id selector falls back to snapshot resolution on runner element miss', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-element-miss';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
      throw new AppError('ELEMENT_NOT_FOUND', 'element not found');
    }
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
            identifier: 'submit',
            rect: { x: 20, y: 80, width: 120, height: 40 },
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
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(2);
  expect(pressCalls[1]?.[2]).toEqual(['80', '100']);
  if (response?.ok) {
    expect(response.data?.selectorChain).toContain('id="submit"');
  }
});

test('click simple iOS id selector rejects distinct runtime candidates after ambiguous runner match', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-direct-selector-ambiguous';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
      throw new AppError('AMBIGUOUS_MATCH', 'Selector matched multiple elements');
    }
    if (command === 'snapshot') {
      return {
        nodes: attachRefs([
          {
            index: 0,
            type: 'Window',
            rect: { x: 0, y: 0, width: 390, height: 844 },
          },
          // Geometry must not choose the visible twin across distinct
          // subtrees after the direct runner delegates ambiguity.
          {
            index: 1,
            parentIndex: 0,
            type: 'XCUIElementTypeButton',
            identifier: 'submit',
            rect: { x: -300, y: 80, width: 120, height: 40 },
            enabled: true,
            hittable: true,
          },
          {
            index: 2,
            parentIndex: 0,
            type: 'XCUIElementTypeButton',
            identifier: 'submit',
            rect: { x: 20, y: 80, width: 120, height: 40 },
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
      positionals: ['id="submit"'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  const pressCalls = mockDispatch.mock.calls.filter((call) => call[1] === 'press');
  expect(pressCalls.length).toBe(1);
  if (response && !response.ok) {
    expect(response.error.code).toBe('AMBIGUOUS_MATCH');
    expect(response.error.details?.matches).toBe(2);
    expect(response.error.details?.candidates).toEqual([
      '@e2 [button] "submit"',
      '@e3 [button] "submit"',
    ]);
    expect(typeof response.error.details?.refsGeneration).toBe('number');
  }
});

test.each([
  ['ELEMENT_NOT_FOUND', 'element not found'],
  ['AMBIGUOUS_MATCH', 'Selector matched multiple elements'],
] as const)(
  'maestro-flagged click keeps runner %s error without snapshot fallback',
  async (code, message) => {
    const sessionStore = makeSessionStore();
    const sessionName = `ios-maestro-direct-selector-${code}`;
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

    mockDispatch.mockImplementation(async (_device, command, _positionals, _out, context) => {
      if (command === 'press' && (context as Record<string, unknown>)?.directElementSelector) {
        throw new AppError(code, message);
      }
      if (command === 'snapshot') {
        throw new Error('snapshot fallback should not run for maestro replay dispatches');
      }
      return {};
    });

    const response = await handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'click',
        positionals: ['id="submit"'],
        flags: { maestro: { allowNonHittableCoordinateFallback: true } },
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    });

    expect(response?.ok).toBe(false);
    if (response?.ok === false) {
      expect(response.error.code).toBe(code);
    }
    expect(mockDispatch.mock.calls.filter((call) => call[1] === 'snapshot')).toHaveLength(0);
  },
);

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

test('direct iOS selector click crosses the ADR 0014 fused seam and expires the ref frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'direct-ios-seam';
  const session = makeStaleRefSession(sessionName);
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) =>
    command === 'snapshot' ? { nodes: makeTwoButtonNodes(), backend: 'xctest' } : {},
  );

  // click + a simple selector on a non-recording iOS session takes the direct
  // iOS selector fast path (no daemon-tree resolution).
  const click = await runInteraction(sessionStore, sessionName, 'click', ['label=Continue']);
  expect(click?.ok).toBe(true);
  const tookDirectPath = mockDispatch.mock.calls.some(
    (call) => (call[4] as { directElementSelector?: unknown })?.directElementSelector !== undefined,
  );
  expect(tookDirectPath).toBe(true);
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});
