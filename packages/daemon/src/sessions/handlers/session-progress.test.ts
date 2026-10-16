import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withTestDeviceInventoryProvider } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { withRequestProgressSink } from '@agent-device/host-kit/request';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { handleSessionCommands } from '../../__tests__/support/handlers/session-command-harness.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  expectOkData,
  makeSessionStore,
} from '../__tests__/replay-suite/session-test-suite.fixtures.ts';

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

async function runSuite(params: {
  root: string;
  requestId: string;
  flags?: DaemonRequest['flags'];
  devices?: DeviceInfo[];
  invoke: (request: DaemonRequest) => Promise<
    | { ok: true; data?: Record<string, unknown> }
    | {
        ok: false;
        error: { code: 'COMMAND_FAILED' | 'ASSERTION_FAILED'; message: string; hint?: string };
      }
  >;
}): Promise<{ events: RequestProgressEvent[]; data: ReturnType<typeof expectOkData> }> {
  const events: RequestProgressEvent[] = [];
  const run = async () =>
    await withRequestProgressSink(
      (event) => events.push(event),
      async () =>
        await handleSessionCommands({
          createCommandSurface: fakeCreateCommandSurface,
          platformServices: daemonPlatformServicesFixture(),
          req: {
            token: 't',
            session: 'default',
            command: 'test',
            positionals: [params.root],
            flags: params.flags,
            meta: { cwd: params.root, requestId: params.requestId },
          },
          sessionName: 'default',
          logPath: path.join(params.root, 'daemon.log'),
          sessionStore: makeSessionStore(),
          invoke: params.invoke,
        }),
    );
  const response = params.devices
    ? await withTestDeviceInventoryProvider(async () => params.devices ?? [], run)
    : await run();
  const data = expectOkData(response);
  return { events, data };
}

function replayEvents(events: RequestProgressEvent[]) {
  return events.filter(
    (event): event is Extract<RequestProgressEvent, { type: 'replay-test' }> =>
      event.type === 'replay-test',
  );
}

test('native suite progress carries skip, retry hint, and attempt session values', async () => {
  const root = mkdtempForTestSync('agent-device-session-test-progress-');
  const skippedPath = path.join(root, '01-untyped.ad');
  const retryPath = path.join(root, '02-retry.ad');
  fs.writeFileSync(skippedPath, 'open "Demo"\n');
  fs.writeFileSync(retryPath, 'context platform=android\nopen "Demo"\n');
  let attempts = 0;

  const { events, data } = await runSuite({
    root,
    requestId: 'progress',
    flags: { platform: 'android', retries: 1 },
    invoke: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'first attempt failed',
            hint: 'retry hint from the failed attempt',
          },
        };
      }
      return { ok: true, data: { replayed: 1, healed: 0 } };
    },
  });

  expect(data.passed).toBe(1);
  expect(data.skipped).toBe(1);
  expect(events[0]).toMatchObject({
    type: 'replay-test-suite',
    status: 'start',
    total: 2,
    runnable: 1,
    skipped: 1,
  });
  const testEvents = replayEvents(events);
  expect(testEvents.map((event) => event.status)).toEqual([
    'skip',
    'start',
    'progress',
    'fail',
    'progress',
    'pass',
  ]);
  expect(testEvents[0]).toMatchObject({
    file: skippedPath,
    status: 'skip',
    index: 1,
    total: 2,
    message: 'missing platform metadata for --platform android',
  });
  expect(testEvents[0]?.durationMs).toBeUndefined();
  expect(testEvents[1]).toMatchObject({
    file: retryPath,
    status: 'start',
    index: 2,
    total: 2,
    maxAttempts: 2,
    session: 'default:test:progress:1-02-retry:attempt-1',
  });
  expect(testEvents[2]).toMatchObject({
    status: 'progress',
    attempt: 1,
    stepIndex: 1,
    stepTotal: 1,
    stepCommand: 'open',
    stepValue: 'Demo',
  });
  expect(testEvents[3]).toMatchObject({
    status: 'fail',
    attempt: 1,
    retrying: true,
    message: 'Replay failed at step 1 (open "Demo"): first attempt failed',
    hint: 'retry hint from the failed attempt',
    session: 'default:test:progress:1-02-retry:attempt-1',
  });
  expect(testEvents[4]).toMatchObject({
    status: 'progress',
    attempt: 2,
    stepCommand: 'open',
    session: 'default:test:progress:1-02-retry:attempt-2',
  });
  expect(testEvents[5]).toMatchObject({
    status: 'pass',
    attempt: 2,
    session: 'default:test:progress:1-02-retry:attempt-2',
  });
});

test('Maestro progress carries its title, step payload, and retry attempt identity', async () => {
  const root = mkdtempForTestSync('agent-device-session-test-maestro-progress-');
  const flowPath = path.join(root, '01-login.yaml');
  fs.writeFileSync(
    flowPath,
    ['appId: demo.app', 'name: Login flow', '---', '- assertNotVisible: "Nope"', '- back', ''].join(
      '\n',
    ),
  );
  let backCalls = 0;

  const { events, data } = await runSuite({
    root,
    requestId: 'maestro-progress',
    flags: { platform: 'android', replayBackend: 'maestro', retries: 1 },
    devices: [ANDROID_ONE],
    invoke: async (request) => {
      if (request.command === 'snapshot') return { ok: true, data: { createdAt: 0, nodes: [] } };
      if (request.command === 'runtime') {
        return { ok: true, data: { viewport: { x: 0, y: 0, width: 400, height: 800 } } };
      }
      if (request.command === 'back' && backCalls++ === 0) {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'first attempt failed' },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(data.passed).toBe(1);
  const testEvents = replayEvents(events);
  const steps = testEvents.filter((event) => event.status === 'progress');
  expect(steps).toHaveLength(4);
  expect(steps.map((event) => [event.attempt, event.stepIndex, event.stepCommand])).toEqual([
    [1, 1, 'assertNotVisible'],
    [1, 2, 'back'],
    [2, 1, 'assertNotVisible'],
    [2, 2, 'back'],
  ]);
  expect(steps[0]).toMatchObject({
    title: 'Login flow',
    stepTotal: 2,
    stepValue: 'Nope',
    session: 'default:test:maestro-progress:1-01-login:attempt-1',
  });
  expect(steps[1]).toMatchObject({
    title: 'Login flow',
    stepTotal: 2,
    session: 'default:test:maestro-progress:1-01-login:attempt-1',
  });
  expect(steps[1]?.stepValue).toBeUndefined();
  expect(steps[2]?.session).toBe('default:test:maestro-progress:1-01-login:attempt-2');
  expect(steps[3]?.session).toBe('default:test:maestro-progress:1-01-login:attempt-2');
  expect(testEvents.filter((event) => event.status === 'fail')[0]).toMatchObject({
    attempt: 1,
    retrying: true,
    hint: 'Retry with --debug and inspect diagnostics log for details.',
  });
  expect(testEvents.filter((event) => event.status === 'pass')[0]).toMatchObject({ attempt: 2 });
});

test('sharded suite progress carries each device and shard-scoped session', async () => {
  const root = mkdtempForTestSync('agent-device-session-test-shard-progress-');
  fs.writeFileSync(path.join(root, '01-login.ad'), 'context platform=android\nopen "Demo"\n');

  const { events } = await runSuite({
    root,
    requestId: 'shard-progress',
    flags: {
      platform: 'android',
      device: 'emulator-5554,emulator-5556',
      shardAll: 2,
    },
    devices: [ANDROID_ONE, ANDROID_TWO],
    invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
  });

  expect(events[0]).toMatchObject({
    type: 'replay-test-suite',
    status: 'start',
    total: 2,
    runnable: 1,
    skipped: 0,
    shardMode: 'all',
    shardCount: 2,
  });
  const starts = replayEvents(events).filter((event) => event.status === 'start');
  expect(starts.map((event) => event.session)).toEqual([
    'default:shard-1:test:shard-progress:1-01-login:attempt-1',
    'default:shard-2:test:shard-progress:1-01-login:attempt-1',
  ]);
  expect(starts.map((event) => event.shardIndex)).toEqual([0, 1]);
  expect(starts.map((event) => event.shardCount)).toEqual([2, 2]);
  expect(starts.map((event) => event.deviceId)).toEqual(['emulator-5554', 'emulator-5556']);
  expect(starts.map((event) => event.deviceName)).toEqual(['Pixel 8', 'Pixel 8 Pro']);
});

test('a terminal replay failure reports its message and hint without retrying', async () => {
  const root = mkdtempForTestSync('agent-device-session-test-terminal-failure-');
  const testPath = path.join(root, '01-terminal-failure.ad');
  fs.writeFileSync(testPath, 'context platform=android\nopen "Demo"\n');
  let attempts = 0;

  const { events, data } = await runSuite({
    root,
    requestId: 'terminal-failure',
    invoke: async () => {
      attempts += 1;
      return {
        ok: false,
        error: {
          code: 'ASSERTION_FAILED',
          message: 'the final assertion failed',
          hint: 'try replay --from 01-terminal-failure.ad',
        },
      };
    },
  });

  expect(attempts).toBe(1);
  expect(data.failed).toBe(1);
  const [failure] = replayEvents(events).filter((event) => event.status === 'fail');
  expect(failure).toMatchObject({
    attempt: 1,
    maxAttempts: 1,
    message: 'Replay failed at step 1 (open "Demo"): the final assertion failed',
    hint: 'try replay --from 01-terminal-failure.ad',
  });
  expect(failure?.retrying).toBeUndefined();
});
