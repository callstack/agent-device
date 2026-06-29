import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSessionCommands } from '../session.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData } from '../../types.ts';
import { type RequestProgressEvent, withRequestProgressSink } from '../../request-progress.ts';
import {
  clearRequestCanceled,
  getRequestSignal,
  markRequestCanceled,
  registerRequestAbort,
} from '../../request-cancel.ts';
import { withDeviceInventoryProvider } from '../../../core/dispatch-resolve.ts';
import type { DeviceInfo } from '../../../utils/device.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/index.ts';

function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-test-suite-'));
  return new SessionStore(path.join(root, 'sessions'));
}

function expectOkData(response: DaemonResponse | null | undefined): DaemonResponseData {
  expect(response?.ok, JSON.stringify(response)).toBeTruthy();
  if (!response || !response.ok) throw new Error('Expected successful daemon response.');
  return response.data ?? {};
}

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

test('test does not retry infrastructure startup failures and stops the suite', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-infra-fail-'));
  fs.writeFileSync(path.join(root, '01-runner.ad'), 'context platform=ios\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-after.ad'), 'context platform=ios\nopen "Demo"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-infra-fail' },
      flags: { retries: 3 },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Runner did not accept connection',
          details: { reason: 'IOS_RUNNER_CONNECT_TIMEOUT' },
        },
      };
    },
  });

  const data = expectOkData(response);
  expect(invoked.length).toBe(1);
  expect(data.executed).toBe(1);
  expect(data.failed).toBe(1);
  expect(data.notRun).toBe(1);
  const tests = data.tests as Array<Record<string, unknown>>;
  expect(tests[0]?.status).toBe('failed');
  expect(tests[0]?.attempts).toBe(1);
});

test('test discovers Maestro YAML suites when replay backend is set', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-maestro-'));
  fs.writeFileSync(
    path.join(root, 'auth-flow.yml'),
    ['appId: demo.app', 'name: Authentication flow', '---', '- launchApp', ''].join('\n'),
  );

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: { platform: 'android', replayBackend: 'maestro' },
      meta: { cwd: root, requestId: 'maestro-suite' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  const data = expectOkData(response);
  expect(invoked.map((req) => [req.command, req.positionals])).toEqual([['open', ['demo.app']]]);
  expect(data.passed).toBe(1);
  expect(data.failed).toBe(0);
  expect((data.tests as Array<Record<string, unknown>>)[0]?.title).toBe('Authentication flow');
});

test('test emits progress when attempts retry and pass', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-progress-'));
  fs.writeFileSync(path.join(root, '01-progress.ad'), 'context platform=ios\nopen "Demo"\n');

  const events: RequestProgressEvent[] = [];
  let attempts = 0;
  const response = await withRequestProgressSink(
    (event) => events.push(event),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [root],
          meta: { cwd: root, requestId: 'suite-progress' },
          flags: { retries: 1 },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => {
          attempts += 1;
          if (attempts === 1) {
            return {
              ok: false,
              error: { code: 'COMMAND_FAILED', message: 'first attempt failed' },
            };
          }
          return { ok: true, data: { replayed: 1, healed: 0 } };
        },
      }),
  );

  const data = expectOkData(response);
  expect(data.passed).toBe(1);
  expect((data.tests as Array<Record<string, unknown>>)[0]?.attemptFailures).toEqual([
    {
      attempt: 1,
      message: 'Replay failed at step 1 (open "Demo"): first attempt failed',
      durationMs: expect.any(Number),
    },
  ]);
  expect(events[0]).toMatchObject({
    type: 'replay-test-suite',
    status: 'start',
    total: 1,
    runnable: 1,
    skipped: 0,
  });
  const testEvents = events.filter((event) => event.type === 'replay-test');
  expect(testEvents.map((event) => event.status)).toEqual([
    'start',
    'progress',
    'fail',
    'progress',
    'pass',
  ]);
  expect(testEvents[1]).toMatchObject({
    type: 'replay-test',
    title: undefined,
    status: 'progress',
    index: 1,
    total: 1,
    attempt: 1,
    maxAttempts: 2,
    stepIndex: 1,
    stepTotal: 1,
  });
  expect(testEvents[2]).toMatchObject({
    type: 'replay-test',
    title: undefined,
    status: 'fail',
    index: 1,
    total: 1,
    attempt: 1,
    maxAttempts: 2,
    durationMs: expect.any(Number),
    retrying: true,
    message: 'Replay failed at step 1 (open "Demo"): first attempt failed',
  });
  expect(testEvents[3]).toMatchObject({
    type: 'replay-test',
    title: undefined,
    status: 'progress',
    index: 1,
    total: 1,
    attempt: 2,
    maxAttempts: 2,
    stepIndex: 1,
    stepTotal: 1,
  });
  expect(testEvents[4]).toMatchObject({
    type: 'replay-test',
    title: undefined,
    status: 'pass',
    index: 1,
    total: 1,
    attempt: 2,
    maxAttempts: 2,
  });
});

test('test emits skip progress without synthetic duration', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-skip-progress-'));
  fs.writeFileSync(path.join(root, '01-missing-platform.ad'), 'open "Demo"\n');
  fs.writeFileSync(path.join(root, '02-android.ad'), 'context platform=android\nopen "Demo"\n');

  const events: RequestProgressEvent[] = [];
  const response = await withRequestProgressSink(
    (event) => events.push(event),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [root],
          meta: { cwd: root, requestId: 'suite-skip-progress' },
          flags: { platform: 'android' },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
      }),
  );

  const data = expectOkData(response);
  expect(data.skipped).toBe(1);
  expect(events[0]).toMatchObject({
    type: 'replay-test-suite',
    status: 'start',
    total: 2,
    runnable: 1,
    skipped: 1,
  });
  const testEvents = events.filter((event) => event.type === 'replay-test');
  expect(testEvents.map((event) => event.status)).toEqual(['skip', 'start', 'progress', 'pass']);
  expect(testEvents[0]).toMatchObject({
    type: 'replay-test',
    status: 'skip',
    index: 1,
    total: 2,
    message: 'missing platform metadata for --platform android',
  });
  expect(testEvents[2]).toMatchObject({
    type: 'replay-test',
    status: 'progress',
    index: 2,
    total: 2,
    stepIndex: 1,
    stepTotal: 1,
  });
  expect(testEvents[0]?.durationMs).toBeUndefined();
});

test('test aggregates snapshot diagnostics from replay session samples', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-snapshots-'));
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-second.ad'), 'context platform=android\nopen "Demo"\n');
  let captures = 0;

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-snapshot-diagnostics' },
      flags: { platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      const session =
        sessionStore.get(req.session) ??
        makeAndroidSession(req.session, {
          snapshotDiagnostics: { samples: [] },
        });
      session.snapshotDiagnostics ??= { samples: [] };
      captures += 1;
      session.snapshotDiagnostics.samples.push({
        durationMs: captures === 1 ? 400 : 1_900,
        backend: 'android',
        platform: 'android',
      });
      sessionStore.set(req.session, session);
      return { ok: true, data: { replayed: 1, healed: 0 } };
    },
  });

  const data = expectOkData(response);
  expect(data.snapshotDiagnostics).toMatchObject({
    stats: {
      count: 2,
      p50Ms: 400,
      p95Ms: 1_900,
      maxMs: 1_900,
      platform: 'android',
    },
    warning: expect.stringContaining('p95 1900ms over 2 captures'),
  });
  expect((data.tests as Array<Record<string, unknown>>)[1]?.snapshotDiagnostics).toMatchObject({
    stats: {
      count: 1,
      p95Ms: 1_900,
    },
  });
});

test('test aggregates snapshot diagnostics from failed replay session samples', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-snapshot-fail-'));
  fs.writeFileSync(path.join(root, '01-fail.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-snapshot-diagnostics-fail' },
      flags: { platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      const session =
        sessionStore.get(req.session) ??
        makeAndroidSession(req.session, {
          snapshotDiagnostics: { samples: [] },
        });
      session.snapshotDiagnostics ??= { samples: [] };
      session.snapshotDiagnostics.samples.push({
        durationMs: 2_100,
        backend: 'android',
        platform: 'android',
      });
      sessionStore.set(req.session, session);
      return {
        ok: false,
        error: { code: 'COMMAND_FAILED', message: 'open failed' },
      };
    },
  });

  const data = expectOkData(response);
  expect(data.failed).toBe(1);
  expect(data.snapshotDiagnostics).toMatchObject({
    stats: {
      count: 1,
      p95Ms: 2_100,
      platform: 'android',
    },
    warning: expect.stringContaining('p95 2100ms over 1 captures'),
  });
  expect((data.tests as Array<Record<string, unknown>>)[0]).toMatchObject({
    status: 'failed',
    snapshotDiagnostics: {
      stats: {
        count: 1,
        p95Ms: 2_100,
      },
    },
  });
});

test('test stops the suite when the parent request is canceled during an active replay attempt', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-parent-cancel-'));
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=ios\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-second.ad'), 'context platform=ios\nopen "Demo"\n');

  const parentRequestId = 'suite-parent-cancel';
  const invokedRequestIds: string[] = [];
  const events: RequestProgressEvent[] = [];
  registerRequestAbort(parentRequestId);

  try {
    const response = await withRequestProgressSink(
      (event) => events.push(event),
      async () =>
        await handleSessionCommands({
          req: {
            token: 't',
            session: 'default',
            command: 'test',
            positionals: [root],
            meta: { cwd: root, requestId: parentRequestId },
          },
          sessionName: 'default',
          logPath: path.join(os.tmpdir(), 'daemon.log'),
          sessionStore,
          invoke: async (req) => {
            const nestedRequestId = req.meta?.requestId;
            expect(nestedRequestId).toBeTypeOf('string');
            invokedRequestIds.push(String(nestedRequestId));
            const signal = getRequestSignal(nestedRequestId);
            expect(signal).toBeDefined();
            queueMicrotask(() => {
              markRequestCanceled(parentRequestId);
            });
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return {
              ok: false,
              error: {
                code: 'COMMAND_FAILED',
                message: 'request canceled',
                details: { reason: 'request_canceled' },
              },
            };
          },
        }),
    );

    const data = expectOkData(response);
    expect(invokedRequestIds).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === 'replay-test' && event.status === 'fail' && event.retrying,
      ),
    ).toBe(false);
    expect(data.failed).toBe(1);
    expect(data.notRun).toBe(1);
  } finally {
    clearRequestCanceled(parentRequestId);
  }
});

test('test --shard-all runs each runnable entry on each selected device', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-shard-all-'));
  fs.writeFileSync(path.join(root, '01-login.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-pay.ad'), 'context platform=android\nopen "Demo"\n');

  const invoked: DaemonRequest[] = [];
  const response = await withDeviceInventoryProvider(
    async () => [ANDROID_ONE, ANDROID_TWO],
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [root],
          meta: { cwd: root, requestId: 'suite-shard-all' },
          flags: {
            platform: 'android',
            device: 'emulator-5554,emulator-5556',
            shardAll: 2,
          },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async (req) => {
          invoked.push(req);
          return { ok: true, data: { replayed: 1, healed: 0 } };
        },
      }),
  );

  const data = expectOkData(response);
  expect(data.total).toBe(4);
  expect(data.passed).toBe(4);
  expect(invoked.map((req) => req.flags?.serial).sort()).toEqual([
    'emulator-5554',
    'emulator-5554',
    'emulator-5556',
    'emulator-5556',
  ]);
  const tests = data.tests as Array<Record<string, unknown>>;
  expect(tests.map((entry) => entry.deviceId)).toEqual([
    'emulator-5554',
    'emulator-5554',
    'emulator-5556',
    'emulator-5556',
  ]);
  expect(tests.map((entry) => entry.deviceName)).toEqual([
    'Pixel 8',
    'Pixel 8',
    'Pixel 8 Pro',
    'Pixel 8 Pro',
  ]);
  expect(tests.map((entry) => entry.artifactsDir)).toEqual([
    expect.stringContaining(`${path.sep}shard-1${path.sep}01-login`),
    expect.stringContaining(`${path.sep}shard-1${path.sep}02-pay`),
    expect.stringContaining(`${path.sep}shard-2${path.sep}01-login`),
    expect.stringContaining(`${path.sep}shard-2${path.sep}02-pay`),
  ]);
  expect(tests.map((entry) => String(entry.session))).toEqual([
    expect.stringContaining('default:shard-1:test:'),
    expect.stringContaining('default:shard-1:test:'),
    expect.stringContaining('default:shard-2:test:'),
    expect.stringContaining('default:shard-2:test:'),
  ]);
});

test('test --shard-split distributes runnable entries by modulo and keeps skips once', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-shard-split-'));
  fs.writeFileSync(path.join(root, '01-missing-platform.ad'), 'open "Demo"\n');
  fs.writeFileSync(path.join(root, '02-a.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '03-b.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '04-c.ad'), 'context platform=android\nopen "Demo"\n');

  const invoked: DaemonRequest[] = [];
  const response = await withDeviceInventoryProvider(
    async () => [ANDROID_TWO, ANDROID_ONE],
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [root],
          meta: { cwd: root, requestId: 'suite-shard-split' },
          flags: { platform: 'android', shardSplit: 2 },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async (req) => {
          invoked.push(req);
          return { ok: true, data: { replayed: 1, healed: 0 } };
        },
      }),
  );

  const data = expectOkData(response);
  expect(data.total).toBe(4);
  expect(data.skipped).toBe(1);
  expect(data.passed).toBe(3);
  const tests = data.tests as Array<Record<string, unknown>>;
  expect(
    tests
      .filter((entry) => entry.status === 'passed')
      .map((entry) => path.basename(String(entry.file))),
  ).toEqual(['02-a.ad', '04-c.ad', '03-b.ad']);
  expect(tests.filter((entry) => entry.status === 'passed').map((entry) => entry.deviceId)).toEqual(
    ['emulator-5554', 'emulator-5554', 'emulator-5556'],
  );
  expect(
    tests.filter((entry) => entry.status === 'passed').map((entry) => entry.deviceName),
  ).toEqual(['Pixel 8', 'Pixel 8', 'Pixel 8 Pro']);
  expect(invoked.map((req) => req.flags?.serial).sort()).toEqual([
    'emulator-5554',
    'emulator-5554',
    'emulator-5556',
  ]);
  expect(tests.filter((entry) => entry.status === 'skipped')).toHaveLength(1);
});

test('test sharding rejects mutually exclusive shard modes', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-shard-modes-'));
  fs.writeFileSync(path.join(root, '01-a.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-shard-modes' },
      flags: { platform: 'android', shardAll: 2, shardSplit: 2 },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
  });

  expect(response?.ok).toBe(false);
  if (response?.ok !== false) throw new Error('Expected failed daemon response.');
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/mutually exclusive/);
});

test('test sharding rejects non-positive shard counts', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-shard-count-'));
  fs.writeFileSync(path.join(root, '01-a.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-shard-count' },
      flags: { platform: 'android', shardAll: 0 },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
  });

  expect(response?.ok).toBe(false);
  if (response?.ok !== false) throw new Error('Expected failed daemon response.');
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/positive integer/);
});

test('test sharding rejects fewer matched devices than requested shards', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-shard-devices-'));
  fs.writeFileSync(path.join(root, '01-a.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await withDeviceInventoryProvider(
    async () => [ANDROID_ONE],
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [root],
          meta: { cwd: root, requestId: 'suite-shard-devices' },
          flags: { platform: 'android', shardAll: 2 },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
      }),
  );

  expect(response?.ok).toBe(false);
  if (response?.ok !== false) throw new Error('Expected failed daemon response.');
  expect(response.error.code).toBe('DEVICE_NOT_FOUND');
  expect(response.error.message).toMatch(/requires 2 devices, but only 1 matched/);
});

test('test sharding does not require devices when every entry is skipped', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-shard-skipped-'));
  fs.writeFileSync(path.join(root, '01-missing-platform.ad'), 'open "Demo"\n');

  let inventoryResolved = false;
  const response = await withDeviceInventoryProvider(
    async () => {
      inventoryResolved = true;
      return [ANDROID_ONE, ANDROID_TWO];
    },
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'test',
          positionals: [root],
          meta: { cwd: root, requestId: 'suite-shard-skipped' },
          flags: { platform: 'android', shardAll: 2 },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => ({ ok: true, data: { replayed: 1, healed: 0 } }),
      }),
  );

  expect(response?.ok).toBe(false);
  if (response?.ok !== false) throw new Error('Expected failed daemon response.');
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toBe('No replay tests matched for --platform android.');
  expect(inventoryResolved).toBe(false);
});
