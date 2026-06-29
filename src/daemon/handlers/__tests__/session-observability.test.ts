import assert from 'node:assert/strict';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import type { AndroidAdbExecutor } from '../../../platforms/android/adb-executor.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeAndroidSession, makeIosSession } from '../../../__tests__/test-utils/index.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { AppleXctracePerfCapture } from '../../../platforms/ios/perf-xctrace.ts';
import type { DaemonResponse } from '../../types.ts';

const applePerfMocks = vi.hoisted(() => ({
  startAppleXctracePerfCapture: vi.fn(),
  stopAppleXctracePerfCapture: vi.fn(),
  writeAppleXctracePerfReport: vi.fn(),
}));

vi.mock('../../../platforms/ios/perf-xctrace.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/ios/perf-xctrace.ts')>();
  return {
    ...actual,
    startAppleXctracePerfCapture: applePerfMocks.startAppleXctracePerfCapture,
    stopAppleXctracePerfCapture: applePerfMocks.stopAppleXctracePerfCapture,
    writeAppleXctracePerfReport: applePerfMocks.writeAppleXctracePerfReport,
  };
});
import { handleSessionObservabilityCommands } from '../session-observability.ts';

beforeEach(() => {
  vi.resetAllMocks();
});

test('network dump validates include mode directly', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', {
    name: 'android',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'network',
      positionals: ['dump', '5', 'invalid-mode'],
      flags: {},
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.ok(response);
  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, /network include mode must be one of/i);
  }
});

test('perf cpu profile xctrace start and stop manage compact artifact lifecycle', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  sessionStore.set(
    'ios',
    makeIosSession('ios', {
      appBundleId: 'com.example.app',
    }),
  );
  const activeCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: '/tmp/app.trace',
    appBundleId: 'com.example.app',
    deviceId: 'ios-sim',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: { kill: vi.fn(() => true), pid: 1234 },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  applePerfMocks.startAppleXctracePerfCapture.mockResolvedValue(activeCapture);
  applePerfMocks.stopAppleXctracePerfCapture.mockResolvedValue({
    ...activeCapture,
    endedAt: '2026-04-01T10:00:05.000Z',
  });

  const startResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['cpu', 'profile', 'start', 'xctrace', 'Time Profiler', '/tmp/app.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(startResponse?.ok, true);
  assert.equal(startResponse?.data?.perf, 'started');
  assert.equal(startResponse?.data?.outPath, '/tmp/app.trace');
  assert.equal(sessionStore.get('ios')?.applePerf?.active?.outPath, '/tmp/app.trace');
  assert.equal(
    applePerfMocks.startAppleXctracePerfCapture.mock.calls[0]?.[0].template,
    'Time Profiler',
  );

  const stopResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['cpu', 'profile', 'stop', 'xctrace', '', '/tmp/app.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(stopResponse?.ok, true);
  assert.equal(stopResponse?.data?.perf, 'stopped');
  assert.equal(sessionStore.get('ios')?.applePerf?.active, undefined);
  assert.equal(sessionStore.get('ios')?.applePerf?.lastProfileTracePath, '/tmp/app.trace');
});

test('perf xctrace stop clears active capture when xctrace cleanup is confirmed', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  const activeCapture = {
    kind: 'xctrace',
    mode: 'trace',
    template: 'Animation Hitches',
    outPath: '/tmp/hitches.trace',
    appBundleId: 'com.example.app',
    deviceId: 'ios-sim',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: { kill: vi.fn(() => true), pid: 1234 },
    wait: Promise.resolve({
      stdout: '',
      stderr: 'Hitches is not supported on this platform.',
      exitCode: 2,
    }),
  };
  sessionStore.set(
    'ios',
    makeIosSession('ios', {
      appBundleId: 'com.example.app',
      applePerf: {
        active: activeCapture as unknown as AppleXctracePerfCapture,
      },
    }),
  );
  applePerfMocks.stopAppleXctracePerfCapture.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'Hitches is not supported on this platform.', {
      captureCleanedUp: true,
    }),
  );

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['trace', 'stop', 'xctrace', '', '/tmp/hitches.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  assert.equal(sessionStore.get('ios')?.applePerf?.active, undefined);
});

test('perf xctrace stop keeps active capture when cleanup is not confirmed', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  const activeCapture = {
    kind: 'xctrace',
    mode: 'trace',
    template: 'Animation Hitches',
    outPath: '/tmp/hitches.trace',
    appBundleId: 'com.example.app',
    deviceId: 'ios-sim',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: { kill: vi.fn(() => true), pid: 1234 },
    wait: new Promise(() => {}),
  };
  sessionStore.set(
    'ios',
    makeIosSession('ios', {
      appBundleId: 'com.example.app',
      applePerf: {
        active: activeCapture as unknown as AppleXctracePerfCapture,
      },
    }),
  );
  applePerfMocks.stopAppleXctracePerfCapture.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'Timed out waiting for Apple xctrace capture to stop', {
      captureCleanedUp: false,
    }),
  );

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['trace', 'stop', 'xctrace', '', '/tmp/hitches.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  assert.equal(sessionStore.get('ios')?.applePerf?.active?.outPath, '/tmp/hitches.trace');
});

test('perf cpu profile report rejects active xctrace captures', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  const activeCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: '/tmp/app.trace',
    appBundleId: 'com.example.app',
    deviceId: 'ios-sim',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: { kill: vi.fn(() => true), pid: 1234 },
    wait: new Promise(() => {}),
  };
  sessionStore.set(
    'ios',
    makeIosSession('ios', {
      appBundleId: 'com.example.app',
      applePerf: {
        active: activeCapture as unknown as AppleXctracePerfCapture,
        lastProfileTracePath: '/tmp/previous.trace',
      },
    }),
  );

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['cpu', 'profile', 'report', 'xctrace', '', '/tmp/app-profile.json'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  assert.equal(applePerfMocks.writeAppleXctracePerfReport.mock.calls.length, 0);
  if (response && !response.ok) {
    assert.match(response.error.message, /stop the active capture first/i);
  }
});

test('perf cpu profile report uses last profile trace and writes compact JSON report', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  sessionStore.set(
    'ios',
    makeIosSession('ios', {
      appBundleId: 'com.example.app',
      applePerf: {
        lastProfileTracePath: '/tmp/app.trace',
        lastProfileTemplate: 'Time Profiler',
      },
    }),
  );
  applePerfMocks.writeAppleXctracePerfReport.mockResolvedValue({
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    tracePath: '/tmp/app.trace',
    reportPath: '/tmp/app-profile.json',
    appBundleId: 'com.example.app',
    generatedAt: '2026-04-01T10:00:05.000Z',
    summary: {
      runCount: 1,
      tableSchemas: ['time-profile'],
    },
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['cpu', 'profile', 'report', 'xctrace', '', '/tmp/app-profile.json'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.perf, 'reported');
  assert.deepEqual(response?.data?.summary, {
    runCount: 1,
    tableSchemas: ['time-profile'],
  });
  assert.equal(
    applePerfMocks.writeAppleXctracePerfReport.mock.calls[0]?.[0].tracePath,
    '/tmp/app.trace',
  );
});

test('perf cpu profile rejects xctrace on Android sessions', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  sessionStore.set(
    'android',
    makeAndroidSession('android', {
      appBundleId: 'com.example.app',
    }),
  );

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['cpu', 'profile', 'start', 'xctrace', 'Time Profiler', '/tmp/app.trace'],
      flags: {},
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, /perf cpu profile requires --kind simpleperf/i);
  }
  assert.equal(applePerfMocks.startAppleXctracePerfCapture.mock.calls.length, 0);
});

test('network dump accepts explicit include flag and rejects conflicting values', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', {
    name: 'android',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });

  const okResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'network',
      positionals: ['dump', '5'],
      flags: { networkInclude: 'headers' },
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.ok(okResponse);
  assert.equal(okResponse?.ok, true);
  if (okResponse?.ok) {
    assert.equal(okResponse.data?.include, 'headers');
  }

  const conflictResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'network',
      positionals: ['dump', '5', 'summary'],
      flags: { networkInclude: 'headers' },
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.ok(conflictResponse);
  assert.equal(conflictResponse?.ok, false);
  if (conflictResponse && !conflictResponse.ok) {
    assert.equal(conflictResponse.error.code, 'INVALID_ARGS');
    assert.match(conflictResponse.error.message, /both positionally and via --include/i);
  }
});

test('perf memory sample routes to memory-only Android sampler', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', {
    name: 'android',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });
  const adbCalls: string[][] = [];
  const androidAdbExecutor: AndroidAdbExecutor = async (args) => {
    adbCalls.push([...args]);
    assert.deepEqual(args, ['shell', 'dumpsys', 'meminfo', 'com.example.app']);
    return {
      stdout: [
        '** MEMINFO in pid 18227 [com.example.app] **',
        '          TOTAL   216524   208232     4384        0    82916    68345    14570',
        'App Summary',
        '  TOTAL PSS:   216,524            TOTAL RSS:   340,112       TOTAL SWAP PSS:        0',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    };
  };

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['memory', 'sample'],
      flags: {},
    },
    sessionName: 'android',
    sessionStore,
    androidAdbExecutor,
  });

  assert.ok(response?.ok);
  if (!response?.ok) assert.fail(JSON.stringify(response));
  assert.deepEqual(adbCalls, [['shell', 'dumpsys', 'meminfo', 'com.example.app']]);
  const metrics = response.data?.metrics as Record<string, any>;
  assert.equal(metrics.memory.available, true);
  assert.equal(metrics.memory.totalPssKb, 216524);
  assert.deepEqual(Object.keys(metrics), ['memory']);
});

test('perf memory snapshot resolves relative output and returns Android artifact metadata', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-perf-memory-cwd-'));
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', {
    name: 'android',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });
  const adbCalls: string[][] = [];
  const androidAdbExecutor: AndroidAdbExecutor = async (args) => {
    adbCalls.push([...args]);
    if (args.join(' ') === 'shell pidof com.example.app') {
      return { stdout: '4242\n', stderr: '', exitCode: 0 };
    }
    if (args.slice(0, 4).join(' ') === 'shell am dumpheap com.example.app') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'pull') {
      fs.writeFileSync(String(args[2]), 'hprof-bytes');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args.slice(0, 3).join(' ') === 'shell rm -f') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected adb call: ${args.join(' ')}`);
  };

  try {
    const response = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['memory', 'snapshot'],
        flags: { kind: 'android-hprof', out: 'heap.hprof' },
        meta: { cwd },
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor,
    });

    assert.ok(response?.ok);
    if (!response?.ok) assert.fail(JSON.stringify(response));
    const artifact = response.data?.artifact as Record<string, unknown>;
    assert.equal(artifact.available, true);
    assert.equal(artifact.kind, 'android-hprof');
    assert.equal(artifact.path, path.join(cwd, 'heap.hprof'));
    assert.equal(artifact.sizeBytes, 'hprof-bytes'.length);
    assert.equal(fs.existsSync(path.join(cwd, 'heap.hprof')), true);
    assert.equal(adbCalls.at(-1)?.slice(0, 3).join(' '), 'shell rm -f');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('perf memory snapshot reports physical iOS memgraph as unavailable', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('ios-device', {
    name: 'ios-device',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'ios',
      id: 'ios-device-1',
      name: 'iPhone',
      kind: 'device',
      booted: true,
    },
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios-device',
      command: 'perf',
      positionals: ['memory', 'snapshot'],
      flags: { kind: 'memgraph' },
    },
    sessionName: 'ios-device',
    sessionStore,
  });

  assert.ok(response?.ok);
  if (!response?.ok) assert.fail(JSON.stringify(response));
  const artifact = response.data?.artifact as Record<string, unknown>;
  assert.equal(artifact.available, false);
  assert.match(String(artifact.reason), /Physical iOS device memgraph capture/i);
  const support = response.data?.support as Record<string, unknown>;
  assert.equal(support.memgraph, false);
});

test('perf rejects kind outside memory snapshot at daemon layer', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', {
    name: 'android',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['frames', 'sample'],
      flags: { kind: 'xctrace' },
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.ok(response);
  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, /--kind is only supported with perf memory snapshot/i);
  }
});

test('perf memory snapshot rejects non-memory perf kind at daemon layer', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', {
    name: 'android',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['memory', 'snapshot'],
      flags: { kind: 'perfetto' },
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.ok(response);
  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(
      response.error.message,
      /perf memory snapshot --kind must be android-hprof or memgraph/i,
    );
  }
});

test('perf memory snapshot returns artifact-shaped unsupported payload on unsupported platforms', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('linux', {
    name: 'linux',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.example.app',
    device: {
      platform: 'linux',
      id: 'linux-host',
      name: 'Linux',
      kind: 'device',
      booted: true,
    },
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'linux',
      command: 'perf',
      positionals: ['memory', 'snapshot'],
      flags: {},
    },
    sessionName: 'linux',
    sessionStore,
  });

  assert.ok(response?.ok);
  if (!response?.ok) assert.fail(JSON.stringify(response));
  assert.equal(response.data?.metrics, undefined);
  const artifact = response.data?.artifact as Record<string, unknown>;
  assert.equal(artifact.available, false);
  assert.equal(artifact.kind, 'memgraph');
  assert.match(String(artifact.reason), /not supported on linux/i);
  const support = response.data?.support as Record<string, unknown>;
  assert.equal(support.memgraph, false);
});

test('perf cpu profile start and stop route through Android simpleperf and preserve compact artifact state', async () => {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-daemon-simpleperf-'),
  );
  const outPath = path.join(tmpDir, 'cpu.perf.data');
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', makeAndroidSession('android', { appBundleId: 'com.example.app' }));
  const adb = makeNativePerfAdbExecutor(outPath);

  try {
    const startResponse = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['cpu', 'profile', 'start', 'simpleperf'],
        flags: { out: outPath },
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor: adb,
    });

    const startData = requireOkData(startResponse, 'Expected start response to succeed');
    assert.equal(startData.kind, 'simpleperf');
    assert.equal(startData.type, 'cpu-profile');
    assert.equal(startData.state, 'running');
    assert.equal(startData.outPath, outPath);
    assert.equal(readAndroidNativePerfState(sessionStore, 'android'), 'running');

    const stopResponse = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['cpu', 'profile', 'stop', 'simpleperf'],
        flags: {},
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor: adb,
    });

    const stopData = requireOkData(stopResponse, 'Expected stop response to succeed');
    assert.equal(stopData.state, 'stopped');
    assert.equal(stopData.outPath, outPath);
    assert.equal(stopData.sizeBytes, 7);
    assert.equal(readAndroidNativePerfState(sessionStore, 'android'), 'stopped');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('perf rejects starting a second Android native capture while one is active', async () => {
  const tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-daemon-double-start-'),
  );
  const outPath = path.join(tmpDir, 'cpu.perf.data');
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', makeAndroidSession('android', { appBundleId: 'com.example.app' }));
  const adb = makeNativePerfAdbExecutor(outPath);

  try {
    const startResponse = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['cpu', 'profile', 'start', 'simpleperf'],
        flags: { out: outPath },
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor: adb,
    });
    requireOkData(startResponse, 'Expected first start response to succeed');

    const secondStartResponse = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['trace', 'start', 'perfetto'],
        flags: { out: path.join(tmpDir, 'app.perfetto-trace') },
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor: adb,
    });

    assert.equal(secondStartResponse?.ok, false);
    if (secondStartResponse && !secondStartResponse.ok) {
      assert.equal(secondStartResponse.error.code, 'COMMAND_FAILED');
      assert.match(secondStartResponse.error.message, /already running/);
      assert.match(JSON.stringify(secondStartResponse.error), /Run perf cpu profile stop/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('perf trace start and stop route through Android perfetto and preserve compact artifact state', async () => {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-device-daemon-perfetto-'));
  const outPath = path.join(tmpDir, 'app.perfetto-trace');
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', makeAndroidSession('android', { appBundleId: 'com.example.app' }));
  const adb = makeNativePerfAdbExecutor(outPath);

  try {
    const startResponse = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['trace', 'start', 'perfetto'],
        flags: { out: outPath },
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor: adb,
    });

    const startData = requireOkData(startResponse, 'Expected perfetto start response to succeed');
    assert.equal(startData.kind, 'perfetto');
    assert.equal(startData.type, 'trace');
    assert.equal(startData.state, 'running');
    assert.equal(readAndroidNativePerfState(sessionStore, 'android'), 'running');

    const stopResponse = await handleSessionObservabilityCommands({
      req: {
        token: 't',
        session: 'android',
        command: 'perf',
        positionals: ['trace', 'stop', 'perfetto'],
        flags: {},
      },
      sessionName: 'android',
      sessionStore,
      androidAdbExecutor: adb,
    });

    const stopData = requireOkData(stopResponse, 'Expected perfetto stop response to succeed');
    assert.equal(stopData.state, 'stopped');
    assert.equal(stopData.outPath, outPath);
    assert.equal(stopData.sizeBytes, 7);
    assert.deepEqual(stopData.summary, {
      capture: {
        durationMs: stopData.durationMs,
        packageName: 'com.example.app',
        appPid: '1234',
        artifactPath: outPath,
        sizeBytes: 7,
      },
      frameHealth: {
        available: true,
        droppedFramePercent: 20,
        droppedFrameCount: 2,
        totalFrameCount: 10,
        method: 'adb-shell-dumpsys-gfxinfo-framestats',
        worstWindows: undefined,
      },
      notes: [
        'Frame health is sampled from Android gfxinfo around the trace window; open the Perfetto artifact for timeline root cause.',
      ],
    });
    assert.equal(readAndroidNativePerfState(sessionStore, 'android'), 'stopped');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('perf trace rejects perfetto on Apple sessions', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('ios', makeIosSession('ios', { appBundleId: 'com.example.app' }));

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['trace', 'start', 'perfetto'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, /supports --kind xctrace/);
  }
});

test('perf cpu profile reports a missing package with an actionable hint', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', makeAndroidSession('android'));

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'perf',
      positionals: ['cpu', 'profile', 'start', 'simpleperf'],
      flags: {},
    },
    sessionName: 'android',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'COMMAND_FAILED');
    assert.match(JSON.stringify(response.error), /Run open <app> first/);
  }
});

function makeNativePerfAdbExecutor(outPath: string): AndroidAdbExecutor {
  const responders = [
    staticAdbResponse(exactAdbArgs('shell', 'pidof', 'com.example.app'), '1234\n'),
    staticAdbResponse(containsAdbArg('command -v simpleperf'), '/system/bin/simpleperf\n'),
    staticAdbResponse(containsAdbArg('command -v perfetto'), '/system/bin/perfetto\n'),
    staticAdbResponse(exactAdbArgs('shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'reset')),
    staticAdbResponse(shellCommandContains('simpleperf'), '5678\n'),
    staticAdbResponse(adbArgsPrefix('shell', 'perfetto'), '5678\n'),
    staticAdbResponse(containsAdbArg('kill -INT')),
    staticAdbResponse(containsAdbArg('stat -c %s'), '7\n'),
    staticAdbResponse(containsAdbArg('rm -f')),
    pullAdbResponse(outPath, 'profile'),
    staticAdbResponse(
      exactAdbArgs('shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'framestats'),
      [
        'Applications Graphics Acceleration Info:',
        'Uptime: 11000 Realtime: 11000',
        '** Graphics info for pid 1234 [com.example.app] **',
        'Stats since: 10000000000ns',
        'Total frames rendered: 10',
        'Janky frames: 2 (20.00%)',
        'Number Frame deadline missed: 2',
      ].join('\n'),
    ),
  ];
  return async (args) => dispatchAdbResponse(args, responders);
}

function requireOkData(response: DaemonResponse | null, message: string): Record<string, unknown> {
  assert.equal(response?.ok, true, JSON.stringify(response));
  if (!response?.ok) throw new Error(message);
  return response.data ?? {};
}

function readAndroidNativePerfState(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
): string | undefined {
  return sessionStore.get(sessionName)?.nativePerf?.android?.state;
}

type MockAdbResult = Awaited<ReturnType<AndroidAdbExecutor>>;

type MockAdbResponder = {
  matches: (args: string[]) => boolean;
  run: (args: string[]) => Promise<MockAdbResult>;
};

async function dispatchAdbResponse(
  args: string[],
  responders: MockAdbResponder[],
): Promise<MockAdbResult> {
  const responder = responders.find((candidate) => candidate.matches(args));
  if (!responder) throw new Error(`Unexpected adb call: ${args.join(' ')}`);
  return await responder.run(args);
}

function staticAdbResponse(matches: MockAdbResponder['matches'], stdout = ''): MockAdbResponder {
  return {
    matches,
    run: async () => ({ exitCode: 0, stdout, stderr: '' }),
  };
}

function pullAdbResponse(outPath: string, contents: string): MockAdbResponder {
  return {
    matches: (args) => args[0] === 'pull',
    run: async (args) => {
      await fsPromises.writeFile(args[2] ?? outPath, contents);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function exactAdbArgs(...expected: string[]): MockAdbResponder['matches'] {
  return (args) => args.join('\0') === expected.join('\0');
}

function adbArgsPrefix(...expected: string[]): MockAdbResponder['matches'] {
  return (args) => expected.every((value, index) => args[index] === value);
}

function containsAdbArg(pattern: string): MockAdbResponder['matches'] {
  return (args) => args.some((arg) => arg.includes(pattern));
}

function shellCommandContains(pattern: string): MockAdbResponder['matches'] {
  return (args) => args[0] === 'shell' && args.slice(1).some((arg) => arg.includes(pattern));
}
