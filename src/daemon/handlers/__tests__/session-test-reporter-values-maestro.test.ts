// Characterization of the shipped reporter contract for the MAESTRO adapter (#1478 P3).
//
// The sibling session-test-reporter-values.test.ts covers the same contract for native `.ad`.
// Both are needed, and neither substitutes for the other: P3 replaced a request-global
// AsyncLocalStorage with an explicit per-attempt `onStep` port, and that port has two
// independent forwarding chains. The native chain is
//   scheduler sink -> runReplayScriptFile -> executeReplayActions -> onStep?.(...)
// and the Maestro chain is a different set of links entirely:
//   scheduler sink -> runReplayScriptFile -> runTypedMaestroReplayFile
//                  -> createMaestroReplayObserver({ onStep }) -> actionStarted -> onStep?.(...)
//
// An `.ad`-only reporter test stays green if any Maestro link is deleted, so `onTestStep`
// would silently stop firing for every `test --maestro` run with no gate objecting. That is
// the same defect class as the dropped diagnosticId/logPath (#1501) and the dropped reporter
// `hint` (#1505): a ratchet that keeps passing while a shipped value disappears.
//
// These tests document today's behavior; they do not propose behavior.

// Maestro replay resolves a target device and captures view hierarchies through
// core/dispatch. These fixtures model no runner, so both are stubbed: the device resolves to a
// fixed Android emulator, and `snapshot` returns an empty hierarchy (which is what makes
// `assertNotVisible` pass deterministically without a screen).
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    resolveTargetDevice: vi.fn(async () => ({
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel 8',
      kind: 'emulator',
      booted: true,
    })),
    dispatchCommand: vi.fn(async () => {
      throw new Error('no device runner available in this test');
    }),
    dispatchGestureViewport: vi.fn(async () => ({ x: 0, y: 0, width: 400, height: 800 })),
  };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import { handleSessionCommands } from './session-command-harness.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { withRequestProgressSink } from '../../../request/progress.ts';
import {
  getReplayTestReporterExitCode,
  runReplayTestReporterProgress,
  runReplayTestReporters,
} from '../../../replay/test/reporters/registry.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterContext,
} from '../../../replay/test/reporters/types.ts';

type RecordedHook = {
  hook: 'onSuiteStart' | 'onTestStart' | 'onTestStep' | 'onTestResult' | 'onSuiteEnd';
  value: Record<string, unknown>;
};

const reporterContext: ReplayTestReporterContext = {
  stdout: { isTTY: false, write() {} },
  stderr: { isTTY: false, write() {} },
};

/**
 * Two steps, so `stepIndex`/`stepTotal` are distinguishable and one step carries a value while
 * the other does not. The flow `name` is what populates the reporter `title` — a value only the
 * Maestro path can produce, since `.ad` scripts have no title.
 */
const MAESTRO_FLOW = [
  'appId: demo.app',
  'name: Login flow',
  '---',
  '- assertNotVisible: "Nope"',
  '- back',
  '',
].join('\n');

function createRecordingReporter(): { reporter: ReplayTestReporter; hooks: RecordedHook[] } {
  const hooks: RecordedHook[] = [];
  return {
    hooks,
    reporter: {
      name: 'recording',
      onSuiteStart: (suite) => void hooks.push({ hook: 'onSuiteStart', value: { ...suite } }),
      onTestStart: (testCase) => void hooks.push({ hook: 'onTestStart', value: { ...testCase } }),
      onTestStep: (testCase) => void hooks.push({ hook: 'onTestStep', value: { ...testCase } }),
      onTestResult: (testCase) => void hooks.push({ hook: 'onTestResult', value: { ...testCase } }),
      onSuiteEnd: (suite) => void hooks.push({ hook: 'onSuiteEnd', value: { ...suite } }),
      getExitCode: (suite) => (suite.failed > 0 ? 1 : 0),
    },
  };
}

function makeSessionStore(root: string): SessionStore {
  return new SessionStore(path.join(root, 'sessions'));
}

/**
 * Runs `test --maestro` exactly as the daemon does, feeding every progress event through the
 * shipped reporter registry — the same translation and dispatch a `--reporter ./mine.mjs`
 * module gets.
 */
async function runMaestroSuiteThroughReporter(params: {
  root: string;
  requestId: string;
  flags?: DaemonRequest['flags'];
  invoke: (req: DaemonRequest) => Promise<DaemonResponse>;
}): Promise<{ hooks: RecordedHook[]; suite: ReplaySuiteResult; exitCode: number }> {
  const { reporter, hooks } = createRecordingReporter();
  const reporters = [reporter];
  const response = await withRequestProgressSink(
    (event) => runReplayTestReporterProgress(reporters, event, reporterContext),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [params.root],
          meta: { cwd: params.root, requestId: params.requestId },
          flags: { replayBackend: 'maestro', platform: 'android', ...params.flags },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore: makeSessionStore(params.root),
        invoke: params.invoke,
      }),
  );

  expect(response?.ok, JSON.stringify(response)).toBeTruthy();
  if (!response?.ok) throw new Error('Expected a successful suite response.');
  const suite = response.data as unknown as ReplaySuiteResult;
  await runReplayTestReporters(reporters, suite, reporterContext);
  return { hooks, suite, exitCode: getReplayTestReporterExitCode(reporters, suite) };
}

/** `snapshot` returns an empty hierarchy; every other command succeeds. */
function maestroInvoke(req: DaemonRequest): DaemonResponse {
  return req.command === 'snapshot'
    ? { ok: true, data: { createdAt: 0, nodes: [] } }
    : { ok: true, data: {} };
}

test('a Maestro suite reaches the reporter with step payloads and attempt-scoped identity', async () => {
  const root = mkdtempForTestSync('agent-device-reporter-maestro-');
  fs.writeFileSync(path.join(root, '01-login.yaml'), MAESTRO_FLOW);

  const { hooks, suite, exitCode } = await runMaestroSuiteThroughReporter({
    root,
    requestId: 'suite-maestro',
    invoke: async (req) => maestroInvoke(req),
  });

  expect(hooks.map((entry) => entry.hook)).toEqual([
    'onSuiteStart',
    'onTestStart',
    'onTestStep',
    'onTestStep',
    'onTestResult',
    'onSuiteEnd',
  ]);

  const suiteArtifactsDir = path.join(root, '.agent-device', 'test-artifacts', 'suite-maestro');
  const testArtifactsDir = path.join(suiteArtifactsDir, '01-login.yaml');
  const session = 'default:test:suite-maestro:1-01-login:attempt-1';

  // The Maestro flow's `name` becomes the reporter `title`. Discovery reads it through
  // `inspectMaestroFlow`, so this is a shipped reporter value the native scenario cannot cover.
  expect(hooks[1]?.value).toMatchObject({
    file: path.join(root, '01-login.yaml'),
    title: 'Login flow',
    index: 1,
    total: 1,
    attempt: undefined,
    maxAttempts: 1,
    session,
    artifactsDir: testArtifactsDir,
  });

  // The two step events: payload comes from the Maestro engine through the observer's
  // `onStep`, while file/index/total/attempt/session/artifactsDir come from the scheduler's
  // per-attempt context. Before P3 the latter half came from request-global AsyncLocalStorage.
  const steps = hooks.filter((entry) => entry.hook === 'onTestStep').map((entry) => entry.value);
  expect(steps).toHaveLength(2);
  expect('status' in steps[0]!).toBe(false);
  expect(steps[0]).toMatchObject({
    file: path.join(root, '01-login.yaml'),
    title: 'Login flow',
    index: 1,
    total: 1,
    attempt: 1,
    maxAttempts: 1,
    session,
    artifactsDir: testArtifactsDir,
    stepIndex: 1,
    stepTotal: 2,
    stepCommand: 'assertNotVisible',
    stepValue: 'Nope',
  });
  expect(steps[1]).toMatchObject({
    index: 1,
    total: 1,
    attempt: 1,
    session,
    artifactsDir: testArtifactsDir,
    stepIndex: 2,
    stepTotal: 2,
    stepCommand: 'back',
  });
  // `back` carries no progress value, and the observer must not invent one.
  expect(steps[1]!.stepValue).toBe(undefined);

  expect(hooks[4]?.value).toMatchObject({
    status: 'pass',
    title: 'Login flow',
    attempt: 1,
    maxAttempts: 1,
    session,
    artifactsDir: testArtifactsDir,
  });
  expect(suite.passed).toBe(1);
  expect(exitCode).toBe(0);
});

test('Maestro step sessions track the running attempt across a retry', async () => {
  const root = mkdtempForTestSync('agent-device-reporter-maestro-retry-');
  fs.writeFileSync(path.join(root, '01-retry.yaml'), MAESTRO_FLOW);

  // The first attempt's `back` fails, so attempt 1 fails at step 2 and attempt 2 passes.
  let backCalls = 0;
  const { hooks, suite } = await runMaestroSuiteThroughReporter({
    root,
    requestId: 'suite-maestro-retry',
    flags: { retries: 1 },
    invoke: async (req) => {
      if (req.command !== 'snapshot') {
        backCalls += 1;
        if (backCalls === 1) {
          return { ok: false, error: { code: 'COMMAND_FAILED', message: 'first attempt failed' } };
        }
      }
      return maestroInvoke(req);
    },
  });

  const steps = hooks.filter((entry) => entry.hook === 'onTestStep').map((entry) => entry.value);

  // Every step event of attempt 1 carries attempt-1's session, and every step event of
  // attempt 2 carries attempt-2's. This is the identity the removed AsyncLocalStorage used to
  // supply, now threaded from the scheduler's attempt context through the Maestro observer.
  const attempts = steps.map((step) => step.attempt);
  const sessions = steps.map((step) => step.session);
  expect(new Set(attempts)).toEqual(new Set([1, 2]));
  for (const [index, step] of steps.entries()) {
    expect(step.session).toBe(
      `default:test:suite-maestro-retry:1-01-retry:attempt-${String(attempts[index])}`,
    );
  }
  expect(new Set(sessions).size).toBe(2);
  expect(steps.every((step) => step.maxAttempts === 2)).toBe(true);

  // The retry result and the final result, both Maestro-produced.
  const results = hooks
    .filter((entry) => entry.hook === 'onTestResult')
    .map((entry) => entry.value);
  expect(results[0]).toMatchObject({
    status: 'fail',
    attempt: 1,
    retrying: true,
    session: 'default:test:suite-maestro-retry:1-01-retry:attempt-1',
  });
  expect(results[1]).toMatchObject({
    status: 'pass',
    attempt: 2,
    retrying: undefined,
    session: 'default:test:suite-maestro-retry:1-01-retry:attempt-2',
  });
  expect(suite.passed).toBe(1);
});
