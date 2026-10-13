import fs from 'node:fs';
import path from 'node:path';
import {
  withDiagnosticsScope,
  flushDiagnosticsToSessionFile,
} from '@agent-device/host-kit/diagnostics';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  buildInteractionResponseData,
  buildTargetedTouchResponsePayloads,
  transformTouchResponseData,
} from '../interaction-touch-response.ts';
import type { PressCommandResult } from '@agent-device/contracts/interaction';
import { daemonPlatformServicesFixture } from '../../../__tests__/platform-services-fixture.ts';
import { fakeCreateCommandSurface as testCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import {
  contextFromFlags,
  installTestScreenRecording,
  makeSession,
} from './interaction-touch-fixtures.ts';

// Pure response-builder suites: every case calls the daemon builders directly. The
// suites that drive `handleInteractionCommands` through the real root command surface
// (the --verify evidence branches) stayed root-side under
// `src/__tests__/daemon-composition/interaction/`, where the surface they exercise lives.

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

beforeEach(() => {
  vi.mocked(getAndroidAppState).mockReset();
  vi.mocked(getAndroidAppState).mockResolvedValue({});
  vi.mocked(getAndroidBlockingDialogObservation).mockReset();
  vi.mocked(getAndroidBlockingDialogObservation).mockResolvedValue({ status: 'clear' });
  vi.mocked(getAndroidScreenSize).mockReset();
  vi.mocked(getAndroidScreenSize).mockResolvedValue({ width: 1344, height: 2992 });
  vi.mocked(captureSnapshotWithInteractor).mockReset();
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
      createCommandSurface: testCreateCommandSurface,
      req: { token: 't', command: 'press', positionals: ['@e1'], session: 'default' },
      sessionName: address,
      sessionRef: ref,
      sessionStore,
      contextFromFlags,
      platformServices: daemonPlatformServicesFixture(),
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
            createCommandSurface: testCreateCommandSurface,
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
            platformServices: daemonPlatformServicesFixture(),
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
          createCommandSurface: testCreateCommandSurface,
          req: { token: 't', command: 'click', positionals: ['1', '2'], session: ref.address },
          sessionName: ref.address,
          sessionRef: ref,
          sessionStore,
          contextFromFlags,
          platformServices: daemonPlatformServicesFixture(),
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
