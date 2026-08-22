import { AppError } from '@agent-device/kernel/errors';
import { beforeEach, expect, test, vi } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockTapElementSelector,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeStaleRefSession,
  runInteraction,
} from './interaction-touch-fixtures.ts';

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
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

beforeEach(() => resetGetRuntimeFixture());

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/window-state.ts';
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
>>>>>>> 23597c6ca (perf(android): answer every window question from one dumpsys read)

test.each([
  ['ELEMENT_NOT_FOUND', 'element not found'],
  ['AMBIGUOUS_MATCH', 'Selector matched multiple elements'],
] as const)(
  'maestro-flagged click keeps runner %s error without snapshot fallback',
  async (code, message) => {
    const sessionStore = makeSessionStore();
    const sessionName = `ios-maestro-direct-selector-${code}`;
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
    mockTapElementSelector.mockRejectedValue(new AppError(code, message));

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
      ...getRuntimeBindings(),
    });

    expect(response?.ok).toBe(false);
    if (response?.ok === false) expect(response.error.code).toBe(code);
  },
);

test('Maestro selector click crosses the ADR 0014 fused seam and expires the ref frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'maestro-direct-ios-seam';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));

  const click = await runInteraction(sessionStore, sessionName, 'click', ['label=Continue'], {
    maestro: { allowNonHittableCoordinateFallback: true },
  });

  expect(click?.ok).toBe(true);
  expect(mockTapElementSelector).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});
