import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearRequestCanceled, markRequestCanceled } from '../../request-cancel.ts';
import {
  mockResolveTargetDevice,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
} from './session-test-harness.ts';
import type { DaemonRequest } from '../../types.ts';
import { handleSessionCommands } from '../session.ts';

test('session_list includes device_udid and ios_simulator_device_set for iOS sessions', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'ios-scoped',
    makeSession('ios-scoped', {
      platform: 'apple',
      id: 'DEF-456',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/simulators',
    }),
  );
  sessionStore.set(
    'android-1',
    makeSession('android-1', {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
  );
  sessionStore.set(
    'macos-1',
    makeSession('macos-1', {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: { token: 't', session: 'default', command: 'session_list', positionals: [] },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const sessions = response.data?.sessions as Array<Record<string, unknown>>;
    expect(Array.isArray(sessions)).toBeTruthy();
    const iosScoped = sessions.find((s) => s.name === 'ios-scoped');
    expect(iosScoped?.device_udid).toBe('DEF-456');
    expect(iosScoped?.ios_simulator_device_set).toBe('/tmp/tenant-a/simulators');
    const android = sessions.find((s) => s.name === 'android-1');
    const macos = sessions.find((s) => s.name === 'macos-1');
    expect(android?.device_udid).toBe(undefined);
    expect(android?.ios_simulator_device_set).toBe(undefined);
    expect(android?.device_id).toBe('emulator-5554');
    expect(macos?.device_id).toBe('host-macos-local');
    expect(macos?.device_udid).toBe(undefined);
    expect(macos?.ios_simulator_device_set).toBe(undefined);
  }
});

test('test filters replay scripts by context platform and skips untyped files', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-filter-'));
  fs.writeFileSync(path.join(root, '01-android.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-ios.ad'), 'context platform=ios\nopen "Settings"\n');
  fs.writeFileSync(path.join(root, '03-untyped.ad'), 'open "Calculator"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: { platform: 'android' },
      meta: { cwd: root, requestId: 'suite-filter' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.flags?.platform).toBe('android');
  expect(invoked[0]?.session).toBe('default:test:suite-filter:1-01-android:attempt-1');
  if (response?.ok) {
    expect(response.data?.passed).toBe(1);
    expect(response.data?.failed).toBe(0);
    expect(response.data?.skipped).toBe(1);
    const tests = response.data?.tests as Array<Record<string, unknown>> | undefined;
    expect(tests?.length).toBe(2);
    expect(tests?.[0]?.status).toBe('passed');
    expect(tests?.[1]?.status).toBe('skipped');
    expect(tests?.[1]?.reason).toBe('skipped-by-filter');
  }
});

test('test binds each replay script to its declared platform metadata', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-platforms-'));
  fs.writeFileSync(path.join(root, '01-android.ad'), 'context platform=android\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-ios.ad'), 'context platform=ios\nopen "Settings"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-platforms' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(invoked.map((req) => req.flags?.platform)).toEqual(['android', 'ios']);
  expect(invoked.map((req) => req.session)).toEqual([
    'default:test:suite-platforms:1-01-android:attempt-1',
    'default:test:suite-platforms:2-02-ios:attempt-1',
  ]);
  if (response?.ok) {
    expect(response.data?.passed).toBe(2);
    expect(response.data?.failed).toBe(0);
    expect(response.data?.skipped).toBe(0);
  }
});

test('test cleans up suite-owned sessions after each executed script', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-cleanup-'));
  fs.writeFileSync(path.join(root, '01-android.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-cleanup' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      sessionStore.set(
        req.session,
        makeSession(req.session, {
          platform: 'android',
          id: 'emulator-5554',
          name: 'Pixel',
          kind: 'emulator',
          booted: true,
        }),
      );
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(sessionStore.get('default:test:suite-cleanup:1-01-android:attempt-1')).toBe(undefined);
});

test('test retries failed scripts with fresh suite-owned sessions', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-retries-'));
  fs.writeFileSync(
    path.join(root, '01-retry.ad'),
    'context platform=android retries=9\nopen "Demo"\n',
  );

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-retries' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      if (invoked.length < 4) {
        return {
          ok: false,
          error: {
            code: 'ASSERTION_FAILED',
            message: 'expected selector to exist',
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  expect(invoked.map((req) => req.session)).toEqual([
    'default:test:suite-retries:1-01-retry:attempt-1',
    'default:test:suite-retries:1-01-retry:attempt-2',
    'default:test:suite-retries:1-01-retry:attempt-3',
    'default:test:suite-retries:1-01-retry:attempt-4',
  ]);
  if (response?.ok) {
    expect(response.data?.passed).toBe(1);
    expect(response.data?.failed).toBe(0);
    const tests = response.data?.tests as Array<Record<string, unknown>> | undefined;
    expect(tests?.[0]?.status).toBe('passed');
    expect(tests?.[0]?.attempts).toBe(4);
  }
});

test('test applies per-script timeout and writes attempt artifacts', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-timeout-'));
  const screenshotPath = path.join(root, 'capture.png');
  fs.writeFileSync(screenshotPath, 'screenshot');
  fs.writeFileSync(
    path.join(root, '01-timeout.ad'),
    'context platform=android timeout=10\nscreenshot "./capture.png"\nopen "Demo"\n',
  );

  let invocationCount = 0;
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-timeout' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (_req) => {
      invocationCount += 1;
      if (invocationCount === 1) {
        return { ok: true, data: { path: screenshotPath } };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBeTruthy();
  if (response?.ok) {
    expect(response.data?.failed).toBe(1);
    const tests = response.data?.tests as Array<Record<string, unknown>> | undefined;
    expect(tests?.[0]?.status).toBe('failed');
    expect(tests?.[0]?.attempts).toBe(1);
    const artifactsDir = tests?.[0]?.artifactsDir;
    expect(typeof artifactsDir).toBe('string');
    const attemptDir = path.join(artifactsDir as string, 'attempt-1');
    expect(fs.existsSync(path.join(attemptDir, 'replay.ad'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'capture.png'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'replay-timing.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'result.txt'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'failure.txt'))).toBe(true);
    const timingLines = fs
      .readFileSync(path.join(attemptDir, 'replay-timing.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(timingLines.some((line) => line.type === 'replay_test_attempt_start')).toBe(true);
    expect(timingLines.some((line) => line.type === 'replay_action_start')).toBe(true);
    expect(
      timingLines.some(
        (line) => line.type === 'replay_test_attempt_stop' && line.timedOut === true,
      ),
    ).toBe(true);
    const resultText = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
    expect(resultText).toMatch(/status: failed/);
    expect(resultText).toMatch(/timeoutMode: cooperative/);
  }
});

test('open does not retain a session when the request was canceled before completion', async () => {
  const sessionStore = makeSessionStore();
  const requestId = 'open-canceled-before-store';
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  } as any);

  markRequestCanceled(requestId);
  try {
    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: 'default',
        command: 'open',
        positionals: ['com.apple.Preferences'],
        flags: { platform: 'ios' },
        meta: { requestId },
      },
      sessionName: 'default',
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(false);
    if (response && !response.ok) {
      expect(response.error.code).toBe('COMMAND_FAILED');
      expect(response.error.message).toBe('request canceled');
    }
    expect(sessionStore.get('default')).toBeUndefined();
  } finally {
    clearRequestCanceled(requestId);
  }
});

test('test returns invalid args when no replay scripts match the platform filter', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-empty-filter-'));
  fs.writeFileSync(path.join(root, '01-ios.ad'), 'context platform=ios\nopen "Settings"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: { platform: 'android' },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(response, 'No replay tests matched for --platform android.');
});

test('test rejects duplicate replay test metadata in the context header', async () => {
  const sessionStore = makeSessionStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-suite-metadata-'));
  fs.writeFileSync(
    path.join(root, '01-invalid.ad'),
    'context platform=ios timeout=1000\ncontext timeout=2000\nopen "Demo"\n',
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Conflicting replay test metadata "timeoutMs" in context header: 1000 vs 2000.',
  );
});
