// Characterization of the shipped reporter contract across the scheduler seam (#1478 P3).
//
// P3 moves the scheduler into `packages/replay-test` and makes attempt identity
// scheduler-owned, mapped back to daemon session names by the daemon adapter. The values a
// custom reporter observes today are therefore the thing most at risk of silent drift, and
// `session` most of all: it is not one value with one provenance, it is four, and they
// disagree on purpose. These tests drive the real suite handler through the real reporter
// registry and pin what a reporter sees. They document today's behavior; they do not
// propose behavior.

// The same reason session-test-suite.test.ts mocks it: ADR 0012 attempts a post-failure
// screen digest via dispatchCommand('snapshot', ...), and these fixtures model no runner.
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => {
      throw new Error('no device runner available in this test');
    }),
  };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import { handleSessionCommands } from '../session.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { withRequestProgressSink } from '../../../request/progress.ts';
import { withDeviceInventoryProvider } from '../../../core/dispatch-resolve.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

const ANDROID_ONE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 8',
  kind: 'emulator',
  booted: true,
};

const ANDROID_TWO: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Pixel 8 Pro',
  kind: 'emulator',
  booted: true,
};

const reporterContext: ReplayTestReporterContext = {
  stdout: { isTTY: false, write() {} },
  stderr: { isTTY: false, write() {} },
};

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

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-reporter-values-');
  return new SessionStore(path.join(root, 'sessions'));
}

/**
 * Runs `test` exactly as the daemon does, feeding every progress event through the shipped
 * reporter registry — the same translation and dispatch a `--reporter ./mine.mjs` module gets.
 */
async function runSuiteThroughReporter(params: {
  root: string;
  requestId: string;
  inputs?: string[];
  flags?: DaemonRequest['flags'];
  invoke: (req: DaemonRequest) => Promise<DaemonResponse>;
  devices?: DeviceInfo[];
}): Promise<{ hooks: RecordedHook[]; suite: ReplaySuiteResult; exitCode: number }> {
  const { reporter, hooks } = createRecordingReporter();
  const reporters = [reporter];
  const call = async () =>
    await withRequestProgressSink(
      (event) => runReplayTestReporterProgress(reporters, event, reporterContext),
      async () =>
        await handleSessionCommands({
          req: {
            token: 't',
            session: 'default',
            command: 'test',
            positionals: params.inputs ?? [params.root],
            meta: { cwd: params.root, requestId: params.requestId },
            flags: params.flags,
          },
          sessionName: 'default',
          logPath: path.join(os.tmpdir(), 'daemon.log'),
          sessionStore: makeSessionStore(),
          invoke: params.invoke,
        }),
    );

  const devices = params.devices;
  const response = devices
    ? await withDeviceInventoryProvider(async () => devices, call)
    : await call();

  expect(response?.ok, JSON.stringify(response)).toBeTruthy();
  if (!response?.ok) throw new Error('Expected a successful suite response.');
  const suite = response.data as unknown as ReplaySuiteResult;
  await runReplayTestReporters(reporters, suite, reporterContext);
  return { hooks, suite, exitCode: getReplayTestReporterExitCode(reporters, suite) };
}

/**
 * One skipped entry (no `context platform=`, filtered out by `--platform android`) followed by
 * one runnable entry that fails its first attempt and passes its retry. Every reporter value a
 * suite can produce shows up once.
 */
async function runRetrySuite(): Promise<{
  root: string;
  hooks: RecordedHook[];
  suite: ReplaySuiteResult;
  exitCode: number;
}> {
  const root = mkdtempForTestSync('agent-device-reporter-session-');
  fs.writeFileSync(path.join(root, '01-untyped.ad'), 'open "Demo"\n');
  fs.writeFileSync(
    path.join(root, '02-retry.ad'),
    'context platform=android retries=1\nopen "Demo"\n',
  );

  let attempts = 0;
  const run = await runSuiteThroughReporter({
    root,
    requestId: 'suite-reporter',
    // Explicit file inputs keep argument order; a directory input enumerates
    // in native readdir order, which is not lexicographic on every filesystem.
    inputs: [path.join(root, '01-untyped.ad'), path.join(root, '02-retry.ad')],
    flags: { platform: 'android' },
    invoke: async () => {
      attempts += 1;
      return attempts === 1
        ? {
            ok: false,
            error: {
              code: 'COMMAND_FAILED',
              message: 'first attempt failed',
              // Carried so the retry-path `hint` below is asserted on a real hook value. The
              // final-attempt path has its own hint coverage; without a hint here the retry
              // emit site was reachable by no assertion at all.
              hint: 'retry hint from the failed attempt',
            },
          }
        : { ok: true, data: { replayed: 1, healed: 0 } };
    },
  });
  return { root, ...run };
}

function hookValue(
  hooks: RecordedHook[],
  index: number,
  hook: RecordedHook['hook'],
): Record<string, unknown> {
  const entry = hooks[index];
  expect(entry, `no hook recorded at ${index}`).toBeDefined();
  expect(entry?.hook).toBe(hook);
  return entry?.value ?? {};
}

const RETRY_SUITE_HOOKS = [
  'onSuiteStart',
  'onTestResult',
  'onTestStart',
  'onTestStep',
  'onTestResult',
  'onTestStep',
  'onTestResult',
  'onSuiteEnd',
] as const;

test('a reporter sees the shipped suite-start, skip, and test-start values', async () => {
  const { root, hooks } = await runRetrySuite();

  expect(hooks.map((entry) => entry.hook)).toEqual([...RETRY_SUITE_HOOKS]);

  const suiteArtifactsDir = path.join(root, '.agent-device', 'test-artifacts', 'suite-reporter');
  expect(hookValue(hooks, 0, 'onSuiteStart')).toEqual({
    total: 2,
    runnable: 1,
    skipped: 1,
    artifactsDir: suiteArtifactsDir,
    shardMode: undefined,
    shardCount: undefined,
  });

  // A skipped entry never opens a session, so the reporter gets no session and no duration.
  expect(hookValue(hooks, 1, 'onTestResult')).toMatchObject({
    file: path.join(root, '01-untyped.ad'),
    status: 'skip',
    index: 1,
    total: 2,
    session: undefined,
    artifactsDir: undefined,
    durationMs: undefined,
    message: 'missing platform metadata for --platform android',
  });

  // The start value is emitted once per test case, BEFORE any attempt runs, so its `session`
  // is `buildReplayTestSessionName(..., attemptIndex = 0)`: always `attempt-1`, even when the
  // case ends up passing on attempt 2. `attempt` is absent while `maxAttempts` is present.
  // Its test number (`1`) is the runnable ordinal; `index` (`2`) is the discovery ordinal.
  expect(hookValue(hooks, 2, 'onTestStart')).toEqual({
    file: path.join(root, '02-retry.ad'),
    title: undefined,
    index: 2,
    total: 2,
    attempt: undefined,
    maxAttempts: 2,
    session: 'default:test:suite-reporter:1-02-retry:attempt-1',
    artifactsDir: path.join(suiteArtifactsDir, '02-retry.ad'),
    shardIndex: undefined,
    shardCount: undefined,
    deviceId: undefined,
    deviceName: undefined,
  });
});

test('reporter step and result sessions track the running attempt, not the start value', async () => {
  const { root, hooks, suite, exitCode } = await runRetrySuite();
  const testArtifactsDir = path.join(
    root,
    '.agent-device',
    'test-artifacts',
    'suite-reporter',
    '02-retry.ad',
  );

  // Step values come from the per-attempt AsyncLocalStorage context, so they track the
  // running attempt: attempt-1 then attempt-2. They carry no `status` key at all.
  const firstStep = hookValue(hooks, 3, 'onTestStep');
  expect('status' in firstStep).toBe(false);
  expect(firstStep).toMatchObject({
    attempt: 1,
    maxAttempts: 2,
    session: 'default:test:suite-reporter:1-02-retry:attempt-1',
    artifactsDir: testArtifactsDir,
    stepIndex: 1,
    stepTotal: 1,
    stepCommand: 'open',
    stepValue: 'Demo',
  });
  expect(hookValue(hooks, 5, 'onTestStep')).toMatchObject({
    attempt: 2,
    session: 'default:test:suite-reporter:1-02-retry:attempt-2',
    stepIndex: 1,
    stepCommand: 'open',
  });

  // The retry result carries the failed attempt's session; the final result carries the last
  // attempt's session. Neither equals the start value once a retry happened.
  expect(hookValue(hooks, 4, 'onTestResult')).toMatchObject({
    status: 'fail',
    attempt: 1,
    maxAttempts: 2,
    retrying: true,
    session: 'default:test:suite-reporter:1-02-retry:attempt-1',
    message: 'Replay failed at step 1 (open "Demo"): first attempt failed',
    // The retry emit site publishes `hint` separately from the final one. Assert it on the
    // real hook value so deleting it from the scheduler fails here rather than shipping a
    // reporter that silently loses the field on every retried failure.
    hint: 'retry hint from the failed attempt',
  });
  const finalResult = hookValue(hooks, 6, 'onTestResult');
  expect(finalResult).toMatchObject({
    status: 'pass',
    attempt: 2,
    maxAttempts: 2,
    retrying: undefined,
    session: 'default:test:suite-reporter:1-02-retry:attempt-2',
    artifactsDir: testArtifactsDir,
  });
  expect(finalResult.durationMs).toEqual(expect.any(Number));

  // onSuiteEnd receives the awaited suite result; its per-test `session` is the final
  // attempt's session, matching the last result value rather than the start value.
  expect(hookValue(hooks, 7, 'onSuiteEnd')).toEqual(suite);
  expect(suite.tests.map((entry) => ('session' in entry ? entry.session : undefined))).toEqual([
    undefined,
    'default:test:suite-reporter:1-02-retry:attempt-2',
  ]);
  expect(exitCode).toBe(0);
});

test('a failing suite reaches the reporter with the failure message, hint fields, and exit code', async () => {
  const root = mkdtempForTestSync('agent-device-reporter-fail-');
  fs.writeFileSync(path.join(root, '01-fail.ad'), 'context platform=android\nopen "Demo"\n');

  const { hooks, suite, exitCode } = await runSuiteThroughReporter({
    root,
    requestId: 'suite-reporter-fail',
    invoke: async () => ({
      ok: false,
      error: { code: 'ASSERTION_FAILED', message: 'selector not found', hint: 'try replay --from' },
    }),
  });

  const results = hooks.filter((entry) => entry.hook === 'onTestResult');
  expect(results).toHaveLength(1);
  expect(hookValue(results, 0, 'onTestResult')).toMatchObject({
    status: 'fail',
    attempt: 1,
    maxAttempts: 1,
    retrying: undefined,
    session: 'default:test:suite-reporter-fail:1-01-fail:attempt-1',
    message: 'Replay failed at step 1 (open "Demo"): selector not found',
    // `hint` is a shipped reporter field: assert it on the real hook value, not
    // just as test input, so dropping `hint: error.hint` from the scheduler
    // path cannot pass this ratchet.
    hint: 'try replay --from',
  });
  expect(suite.failed).toBe(1);
  expect(exitCode).toBe(1);
});

test('sharded runs give the reporter shard-scoped sessions and device identity', async () => {
  const root = mkdtempForTestSync('agent-device-reporter-shard-');
  fs.writeFileSync(path.join(root, '01-login.ad'), 'context platform=android\nopen "Demo"\n');

  const { hooks } = await runSuiteThroughReporter({
    root,
    requestId: 'suite-reporter-shard',
    flags: {
      platform: 'android',
      device: 'emulator-5554,emulator-5556',
      shardAll: 2,
    },
    devices: [ANDROID_ONE, ANDROID_TWO],
    invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
  });

  // Shipped asymmetry: `total` is shard-multiplied (1 file x 2 shards) while `runnable` and
  // `skipped` are counted before sharding, so a sharded suite-start value reports
  // total 2 / runnable 1. Pinned as-is; the extraction must not "fix" it silently.
  expect(hookValue(hooks, 0, 'onSuiteStart')).toEqual({
    total: 2,
    runnable: 1,
    skipped: 0,
    artifactsDir: path.join(root, '.agent-device', 'test-artifacts', 'suite-reporter-shard'),
    shardMode: 'all',
    shardCount: 2,
  });

  const starts = hooks.filter((entry) => entry.hook === 'onTestStart');
  expect(starts.map((entry) => entry.value.session)).toEqual([
    'default:shard-1:test:suite-reporter-shard:1-01-login:attempt-1',
    'default:shard-2:test:suite-reporter-shard:1-01-login:attempt-1',
  ]);
  expect(starts.map((entry) => entry.value.shardIndex)).toEqual([0, 1]);
  expect(starts.map((entry) => entry.value.shardCount)).toEqual([2, 2]);
  expect(starts.map((entry) => entry.value.deviceId)).toEqual(['emulator-5554', 'emulator-5556']);
  expect(starts.map((entry) => entry.value.deviceName)).toEqual(['Pixel 8', 'Pixel 8 Pro']);
});
