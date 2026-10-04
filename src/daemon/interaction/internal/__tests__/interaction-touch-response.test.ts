import fs from 'node:fs';
import path from 'node:path';
import {
  withDiagnosticsScope,
  flushDiagnosticsToSessionFile,
} from '@agent-device/host-kit/diagnostics';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import {
  buildInteractionResponseData,
  buildTargetedTouchResponsePayloads,
  transformTouchResponseData,
} from '../interaction-touch-response.ts';
import type { PressCommandResult } from '@agent-device/contracts/interaction';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
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

test('commandless longpress response omits internal interaction diagnostics', () => {
  expect(
    transformTouchResponseData({
      flags: {},
      data: {
        currentUptimeMs: 900,
        gestureStartUptimeMs: 100,
        gestureEndUptimeMs: 800,
        sequenceResults: [{ index: 0, success: true }],
        completedSteps: 1,
      },
    }),
  ).toEqual({ completedSteps: 1 });
});

function selectorResult(readiness?: { polls: number; waitedMs: number }): PressCommandResult {
  return {
    kind: 'selector',
    point: { x: 10, y: 20 },
    target: { kind: 'selector', selector: 'label=Continue' },
    node: { ref: 'e1', index: 0, type: 'Button', label: 'Continue' },
    selectorChain: ['label=Continue'],
    warning: 'earlier warning',
    ...(readiness ? { readiness } : {}),
  };
}

const WAITED_SELECTOR_RESULT = selectorResult({ polls: 3, waitedMs: 400 });

test.each([false, true])('selector-touch observation after retirement=%s', async (retired) => {
  const sessionStore = makeSessionStore();
  const address = 'cwd:selector-touch-response:default';
  const session = makeSession('default');
  session.snapshot = {
    nodes: attachRefs([{ index: 0, type: 'Button', label: 'Continue' }]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.snapshotGeneration = 3;
  const ref = sessionStore.publish(address, session);
  const result: PressCommandResult = {
    ...selectorResult(),
    settle: {
      settled: true,
      waitedMs: 25,
      captures: 2,
      quietMs: 25,
      timeoutMs: 2000,
      diff: {
        summary: { additions: 1, removals: 0, unchanged: 0 },
        lines: [{ kind: 'added', text: 'Continue', ref: 'e1' }],
      },
    },
  };
  let successor;
  if (retired) {
    sessionStore.retire(ref);
    successor = sessionStore.publish(address, makeSession('default'));
  }
  const payloads = await buildTargetedTouchResponsePayloads({
    params: {
      req: { token: 't', command: 'press', positionals: ['@e1'], session: 'default' },
      sessionName: address,
      sessionRef: ref,
      sessionStore,
      contextFromFlags,
      captureSnapshotForSession: vi.fn(),
    },
    result,
    staleRefsWarning: undefined,
    extra: {},
  });
  if (retired) {
    expect(payloads.responseData.settle).toBeUndefined();
    expect(payloads.result.settle).toBeUndefined();
    expect(sessionStore.lookup(address)).toEqual(successor);
    expect(successor?.session.snapshot).toBeUndefined();
  } else {
    expect(payloads.responseData.settle).toMatchObject({ refsGeneration: 3, settled: true });
  }
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'point-touch publication after a held frame probe, retired=%s, fails=%s',
  async (retired, fails) => {
    const sessionStore = makeSessionStore();
    const address = 'cwd:held-touch-response:default';
    const session = makeSession('default');
    session.snapshot = {
      nodes: attachRefs([{ index: 0, type: 'Button', label: 'Continue' }]),
      createdAt: Date.now(),
      backend: 'xctest',
    };
    session.snapshotGeneration = 3;
    installTestScreenRecording(session);
    const ref = sessionStore.publish(address, session);
    let startProbe!: () => void;
    let releaseProbe!: () => void;
    const probing = new Promise<void>((resolve) => {
      startProbe = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const result: PressCommandResult = {
      kind: 'point',
      point: { x: 10, y: 20 },
      settle: {
        settled: true,
        waitedMs: 25,
        captures: 2,
        quietMs: 25,
        timeoutMs: 2000,
        diff: {
          summary: { additions: 1, removals: 0, unchanged: 0 },
          lines: [{ kind: 'added', text: 'Continue', ref: 'e1' }],
        },
      },
    };
    const logPath = path.join(mkdtempForTestSync('held-point-'), 'request.log');
    const running = withDiagnosticsScope(
      { command: 'press', session: address, logPath, debug: true },
      async () => {
        const payloads = await buildTargetedTouchResponsePayloads({
          params: {
            req: {
              token: 't',
              command: 'press',
              positionals: ['10', '20'],
              session: 'default',
              flags: {},
            },
            sessionName: address,
            sessionRef: ref,
            sessionStore,
            contextFromFlags,
            captureSnapshotForSession: async () => {
              startProbe();
              await released;
              if (fails) throw new Error('frame capture failed');
              return sessionStore.requireCurrent(ref).snapshot!;
            },
          },
          result,
          staleRefsWarning: undefined,
          extra: {},
        });
        flushDiagnosticsToSessionFile({ force: true });
        return payloads;
      },
    );
    await probing;
    let successor;
    if (retired) {
      sessionStore.retire(ref);
      successor = sessionStore.publish(address, makeSession('default'));
    }
    releaseProbe();
    const payloads = await running;
    const diagnostics = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    expect(diagnostics.includes('touch_reference_frame_resolve_failed')).toBe(!retired && fails);
    expect(payloads.responseData.x).toBe(10);
    if (retired) {
      expect(payloads.responseData.settle).toBeUndefined();
      expect(payloads.result.settle).toBeUndefined();
      expect(sessionStore.lookup(address)).toEqual(successor);
      expect(successor?.session.snapshot).toBeUndefined();
    } else {
      expect(payloads.responseData.settle).toMatchObject({ refsGeneration: 3, settled: true });
    }
  },
);

test('the response builder reports the resolved wait and keeps the prior warning', () => {
  const { responseData, result } = buildInteractionResponseData({
    source: { kind: 'runtime', result: WAITED_SELECTOR_RESULT },
    referenceFrame: undefined,
    staleRefsWarning: 'stale refs',
  });

  expect(responseData.readiness).toEqual({ polls: 3, waitedMs: 400 });
  expect(responseData.warning).toBe('earlier warning stale refs');
  expect(result.readiness).toBeUndefined();
});

test('the response builder omits readiness when nothing waited', () => {
  const { responseData } = buildInteractionResponseData({
    source: { kind: 'runtime', result: selectorResult() },
    referenceFrame: undefined,
  });

  expect('readiness' in responseData).toBe(false);
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

  // Post-action capture reports an extra node, so changedFromBefore should
  // read true against the pre-action (stored) snapshot's single node.
  mockCaptureSnapshotForSession.mockResolvedValue({
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
    producer: 'apple-runner',
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
    ...getRuntimeBindings(),
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
  expect(mockTapPoint).toHaveBeenCalledOnce();
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledOnce();
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
  mockTapPoint.mockResolvedValue({ pressed: true });

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
  if (response?.ok) {
    expect(response.data?.evidence).toBeUndefined();
  }
  // No verify flag means no post-action snapshot capture at all.
  expect(mockTapPoint).toHaveBeenCalledOnce();
  expect(mockCaptureSnapshotForSession).not.toHaveBeenCalled();
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

  mockCaptureSnapshotForSession.mockResolvedValue({
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
    producer: 'apple-runner',
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
    ...getRuntimeBindings(),
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

  mockCaptureSnapshotForSession.mockResolvedValue({
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
    producer: 'apple-runner',
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
    ...getRuntimeBindings(),
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.evidence).toBeUndefined();
  }
  // No verify flag means no post-action snapshot capture at all.
  expect(mockCaptureSnapshotForSession).not.toHaveBeenCalled();
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

  mockFillPoint.mockResolvedValue({ filled: true });
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
    ...getRuntimeBindings(),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);

  const stored = sessionStore.get(sessionName);
  expect(stored).toBeTruthy();
  expect(mockFillPoint).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 55 }));
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

test('an already retired coordinate touch skips its frame probe without a warning', async () => {
  const sessionStore = makeSessionStore();
  const ref = sessionStore.publish('retired-point', makeSession('retired-point'));
  sessionStore.retire(ref);
  const capture = vi.fn();
  const logPath = path.join(mkdtempForTestSync('retired-point-'), 'request.log');
  await withDiagnosticsScope(
    { command: 'click', session: ref.address, logPath, debug: true },
    async () => {
      const payloads = await buildTargetedTouchResponsePayloads({
        params: {
          req: { token: 't', command: 'click', positionals: ['1', '2'], session: ref.address },
          sessionName: ref.address,
          sessionRef: ref,
          sessionStore,
          contextFromFlags,
          captureSnapshotForSession: capture,
        },
        result: { kind: 'point', point: { x: 1, y: 2 } },
        staleRefsWarning: undefined,
        extra: {},
      });
      expect(payloads.responseData).toMatchObject({ x: 1, y: 2 });
      flushDiagnosticsToSessionFile({ force: true });
    },
  );
  expect(capture).not.toHaveBeenCalled();
  expect(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '').not.toContain(
    'touch_reference_frame_resolve_failed',
  );
});
