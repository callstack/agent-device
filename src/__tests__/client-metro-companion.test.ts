import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: vi.fn(),
  readProcessCommand: vi.fn(),
  readProcessStartTime: vi.fn(),
  waitForProcessExit: vi.fn(),
}));

import { runCmdDetached } from '@agent-device/host-kit/command';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '@agent-device/host-kit/process';

import { ensureMetroCompanion, stopMetroCompanion } from '../metro/client-metro-companion.ts';
import { ensureReactDevtoolsCompanion } from '../client/client-react-devtools-companion.ts';

const TEST_BRIDGE_SCOPE = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  leaseId: 'lease-1',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function assertCompanionSpawnTarget(): void {
  const firstCall = vi.mocked(runCmdDetached).mock.calls[0];
  assert.ok(firstCall, 'expected runCmdDetached to be called');
  assert.equal(firstCall[0], process.execPath);
  assert.ok(
    firstCall[1].some((arg) => arg.includes('src/client/companion-tunnel.ts')),
    `expected companion entry path in ${JSON.stringify(firstCall[1])}`,
  );
  assert.equal(firstCall[1].at(-1), '--agent-device-run-metro-companion');
}

function assertCompanionRunArg(callIndex: number, runArg: string): void {
  const call = vi.mocked(runCmdDetached).mock.calls[callIndex];
  assert.ok(call, `expected runCmdDetached call ${callIndex}`);
  assert.equal(call[1].at(-1), runArg);
}

test('companion ownership is profile-scoped and consumer-counted', async () => {
  const projectRoot = mkdtempForTestSync('agent-device-metro-companion-state-');
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(111).mockReturnValueOnce(222);
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockImplementation((pid) =>
      pid === 111 ? 'start-111' : 'start-222',
    );
    vi.mocked(readProcessCommand).mockImplementation(
      () => `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
    );
    vi.mocked(waitForProcessExit).mockResolvedValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const stagingFirst = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://staging',
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-a',
    });
    const stagingSecond = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://staging',
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-b',
    });
    const prod = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://prod',
      profileKey: '/tmp/prod.json',
      consumerKey: 'session-prod',
    });

    assert.equal(stagingFirst.spawned, true);
    assert.equal(stagingSecond.spawned, false);
    assert.notEqual(stagingFirst.statePath, prod.statePath);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 2);
    assertCompanionSpawnTarget();
    assert.equal(fs.existsSync(stagingFirst.logPath), true);
    assert.equal(fs.existsSync(prod.logPath), true);

    const stagingState = JSON.parse(fs.readFileSync(stagingFirst.statePath, 'utf8')) as {
      consumers: string[];
    };
    assert.deepEqual(stagingState.consumers.sort(), ['session-a', 'session-b']);

    const partialStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-a',
    });
    assert.equal(partialStop.stopped, false);
    assert.equal(killSpy.mock.calls.length, 0);

    const remainingState = JSON.parse(fs.readFileSync(stagingFirst.statePath, 'utf8')) as {
      consumers: string[];
    };
    assert.deepEqual(remainingState.consumers, ['session-b']);

    const finalStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-b',
    });
    assert.equal(finalStop.stopped, true);
    assert.equal(killSpy.mock.calls.length, 1);
    assert.deepEqual(killSpy.mock.calls[0], [111, 'SIGTERM']);
    assert.equal(fs.existsSync(stagingFirst.statePath), false);
    assert.equal(fs.existsSync(stagingFirst.logPath), false);

    const prodStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/prod.json',
      consumerKey: 'session-prod',
    });
    assert.equal(prodStop.stopped, true);
    assert.equal(killSpy.mock.calls.length, 2);
    assert.deepEqual(killSpy.mock.calls[1], [222, 'SIGTERM']);
    assert.equal(fs.existsSync(prod.statePath), false);
    assert.equal(fs.existsSync(prod.logPath), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('launchUrl changes force a companion respawn for the same profile', async () => {
  const projectRoot = mkdtempForTestSync('agent-device-metro-companion-launch-');
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(333).mockReturnValueOnce(444);
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockImplementation((pid) =>
      pid === 333 ? 'start-333' : 'start-444',
    );
    vi.mocked(readProcessCommand).mockImplementation(
      () => `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
    );
    vi.mocked(waitForProcessExit).mockResolvedValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const first = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://first',
      profileKey: '/tmp/profile.json',
      consumerKey: 'session-a',
    });
    const second = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://second',
      profileKey: '/tmp/profile.json',
      consumerKey: 'session-a',
    });

    assert.equal(first.spawned, true);
    assert.equal(second.spawned, true);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 2);
    assert.equal(killSpy.mock.calls.length, 1);
    assertCompanionSpawnTarget();
    assert.deepEqual(killSpy.mock.calls[0], [333, 'SIGTERM']);

    const state = JSON.parse(fs.readFileSync(second.statePath, 'utf8')) as {
      launchUrl?: string;
    };
    assert.equal(state.launchUrl, 'myapp://second');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('metro and React DevTools companions use distinct profile state paths', async () => {
  const projectRoot = mkdtempForTestSync('agent-device-companion-paths-');
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(777).mockReturnValueOnce(888);
    vi.mocked(readProcessStartTime).mockImplementation((pid) =>
      pid === 777 ? 'start-777' : 'start-888',
    );
    vi.mocked(readProcessCommand).mockImplementation((pid) =>
      pid === 888
        ? `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-react-devtools-companion`
        : `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
    );

    const profileKey = '/tmp/shared-remote.json';
    const metro = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://open',
      profileKey,
      consumerKey: 'session-a',
    });
    const reactDevtools = await ensureReactDevtoolsCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      bridgeScope: TEST_BRIDGE_SCOPE,
      session: 'session-a',
      profileKey,
      consumerKey: 'session-a',
    });

    assert.notEqual(metro.statePath, reactDevtools.statePath);
    assert.notEqual(metro.logPath, reactDevtools.logPath);
    assert.match(metro.statePath, /metro-companion[/\\]metro-companion-[a-f0-9]+\.json$/);
    assert.match(
      reactDevtools.statePath,
      /react-devtools-companion[/\\]react-devtools-companion-[a-f0-9]+\.json$/,
    );
    assertCompanionRunArg(0, '--agent-device-run-metro-companion');
    assertCompanionRunArg(1, '--agent-device-run-react-devtools-companion');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('spawned companion uses neutral env names', async () => {
  const projectRoot = mkdtempForTestSync('agent-device-companion-env-');
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(999);
    vi.mocked(readProcessStartTime).mockReturnValue('start-999');
    vi.mocked(readProcessCommand).mockReturnValue(
      `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
    );

    await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://open',
      env: {},
    });

    const env = vi.mocked(runCmdDetached).mock.calls[0]?.[2]?.env;
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SERVER_BASE_URL, 'https://bridge.example.test');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_BEARER_TOKEN, 'token');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_LOCAL_BASE_URL, 'http://127.0.0.1:8081');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_LAUNCH_URL, 'myapp://open');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_REGISTER_PATH, '/api/metro/companion/register');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_TENANT_ID, 'tenant-1');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_RUN_ID, 'run-1');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_LEASE_ID, 'lease-1');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('state sentinel exists before spawning companion worker', async () => {
  const projectRoot = mkdtempForTestSync('agent-device-companion-sentinel-');
  try {
    vi.mocked(runCmdDetached).mockImplementationOnce((_, __, options) => {
      const statePath = options?.env?.AGENT_DEVICE_COMPANION_TUNNEL_STATE_PATH;
      if (typeof statePath !== 'string') {
        throw new Error('expected companion state path env');
      }
      assert.equal(fs.existsSync(statePath), true);
      assert.equal(fs.readFileSync(statePath, 'utf8'), '');
      return 1001;
    });
    vi.mocked(readProcessStartTime).mockReturnValue('start-1001');
    vi.mocked(readProcessCommand).mockReturnValue(
      `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
    );

    const spawned = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      consumerKey: 'session-a',
    });

    const state = JSON.parse(fs.readFileSync(spawned.statePath, 'utf8')) as {
      pid?: number;
      consumers?: string[];
    };
    assert.equal(state.pid, 1001);
    assert.deepEqual(state.consumers, ['session-a']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

function writeOwnCompanionState(projectRoot: string, pid: number): string {
  const statePath = path.join(projectRoot, '.agent-device', 'metro-companion.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({
      pid,
      serverBaseUrl: 'https://bridge.example.test',
      localBaseUrl: 'http://127.0.0.1:8081',
      tokenHash: 'token-hash',
      consumers: [],
    })}\n`,
  );
  return statePath;
}

function errnoException(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

const COMPANION_TUNNEL_COMMAND = `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`;

type CompanionTeardownCase = Readonly<{
  name: string;
  pid: number;
  processAlive: boolean;
  processCommand: string | null;
  /** One entry per `process.kill` call: an errno to throw, or true when the signal is accepted. */
  killOutcomes: Array<true | 'EPERM' | 'ESRCH' | 'EACCES'>;
  /** One entry per `waitForProcessExit` call: whether the companion exited in that window. */
  exitOutcomes: boolean[];
  expect: Readonly<{
    rejection?: string;
    stopped?: boolean;
    killCalls: Array<[number, 'SIGTERM' | 'SIGKILL']>;
    exitWaitCalls: Array<[number, number]>;
    keepsState: boolean;
  }>;
}>;

const COMPANION_TEARDOWN_CASES: CompanionTeardownCase[] = [
  {
    // The recorded pid is already gone: nothing to signal, and the artifacts are cleared.
    name: 'clears artifacts when the recorded pid is already gone',
    pid: 4001,
    processAlive: false,
    processCommand: COMPANION_TUNNEL_COMMAND,
    killOutcomes: [],
    exitOutcomes: [],
    expect: { stopped: true, killCalls: [], exitWaitCalls: [], keepsState: false },
  },
  {
    // The process is alive but its command line is unreadable: never signal an unknown pid.
    name: 'never signals a pid whose command line is unreadable',
    pid: 4002,
    processAlive: true,
    processCommand: null,
    killOutcomes: [],
    exitOutcomes: [],
    expect: { stopped: true, killCalls: [], exitWaitCalls: [], keepsState: false },
  },
  {
    // SIGTERM is refused (EPERM). The shared stopper reads "signal refused" as already-exited, so
    // teardown reports stopped, skips the exit wait and SIGKILL, and drops the state file without
    // confirming an exit. EPERM can also mean a companion still running under another owner, which
    // is why the daemon's own stopper keeps its registration instead (`signal-failed` in
    // src/daemon/daemon-stop.ts); companion teardown keeps the weaker local-dev contract that a pid
    // we cannot signal is not ours to keep tracking.
    name: 'reads a refused SIGTERM as already exited',
    pid: 4003,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    killOutcomes: ['EPERM'],
    exitOutcomes: [],
    expect: {
      stopped: true,
      killCalls: [[4003, 'SIGTERM']],
      exitWaitCalls: [],
      keepsState: false,
    },
  },
  {
    // SIGTERM is ignored: escalate to SIGKILL and wait for the exit again.
    name: 'escalates an ignored SIGTERM to SIGKILL',
    pid: 4004,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    killOutcomes: [true, true],
    exitOutcomes: [false, true],
    expect: {
      stopped: true,
      killCalls: [
        [4004, 'SIGTERM'],
        [4004, 'SIGKILL'],
      ],
      exitWaitCalls: [
        [4004, 1_000],
        [4004, 1_000],
      ],
      keepsState: false,
    },
  },
  {
    // SIGKILL loses the race (ESRCH): stop without waiting on a pid that is already gone.
    name: 'skips the second exit wait when SIGKILL loses the race',
    pid: 4005,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    killOutcomes: [true, 'ESRCH'],
    exitOutcomes: [false],
    expect: {
      stopped: true,
      killCalls: [
        [4005, 'SIGTERM'],
        [4005, 'SIGKILL'],
      ],
      exitWaitCalls: [[4005, 1_000]],
      keepsState: false,
    },
  },
  {
    // A signalling failure that is not a race is reported, and the state file survives so the
    // companion can be retried instead of being orphaned silently.
    name: 'reports a non-race SIGTERM failure and keeps the state for retry',
    pid: 4006,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    killOutcomes: ['EACCES'],
    exitOutcomes: [],
    expect: {
      rejection: 'simulated EACCES',
      killCalls: [[4006, 'SIGTERM']],
      exitWaitCalls: [],
      keepsState: true,
    },
  },
  {
    // The same holds when only the escalation fails for a non-race reason: the retry stops the
    // same still-recorded companion and fails on SIGKILL.
    name: 'reports a non-race SIGKILL escalation failure and keeps the state for retry',
    pid: 4007,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    killOutcomes: [true, 'EACCES'],
    exitOutcomes: [false],
    expect: {
      rejection: 'simulated EACCES',
      killCalls: [
        [4007, 'SIGTERM'],
        [4007, 'SIGKILL'],
      ],
      exitWaitCalls: [[4007, 1_000]],
      keepsState: true,
    },
  },
];

// Each case owns its projectRoot, state file, pid, and mock outcomes, so one failure cannot hide
// the later scenarios the way the original chained test allowed.
test.each(COMPANION_TEARDOWN_CASES)(
  'stopping a companion survives the teardown race: $name',
  async ({
    pid,
    processAlive,
    processCommand,
    killOutcomes,
    exitOutcomes,
    expect: expectation,
  }) => {
    const projectRoot = mkdtempForTestSync('agent-device-metro-companion-teardown-');
    const statePath = writeOwnCompanionState(projectRoot, pid);
    try {
      vi.mocked(isProcessAlive).mockReturnValue(processAlive);
      vi.mocked(readProcessCommand).mockReturnValue(processCommand);
      let killIndex = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const outcome = killOutcomes[killIndex];
        if (outcome === undefined) {
          throw new Error(`unexpected process.kill call #${killIndex + 1}`);
        }
        killIndex += 1;
        if (outcome !== true) throw errnoException(outcome);
        return true;
      });
      let exitIndex = 0;
      vi.mocked(waitForProcessExit).mockImplementation(async () => {
        const outcome = exitOutcomes[exitIndex];
        if (outcome === undefined) {
          throw new Error(`unexpected waitForProcessExit call #${exitIndex + 1}`);
        }
        exitIndex += 1;
        return outcome;
      });

      if (expectation.rejection !== undefined) {
        await assert.rejects(
          () => stopMetroCompanion({ projectRoot }),
          new RegExp(expectation.rejection),
        );
      } else {
        assert.equal(
          (await stopMetroCompanion({ projectRoot })).stopped,
          expectation.stopped === true,
        );
      }
      assert.deepEqual(killSpy.mock.calls, expectation.killCalls);
      assert.deepEqual(
        vi.mocked(waitForProcessExit).mock.calls.map((call) => [call[0], call[1]]),
        expectation.exitWaitCalls,
      );
      assert.equal(fs.existsSync(statePath), expectation.keepsState);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  },
);

test('legacy state without bridge scope is stopped before respawn', async () => {
  const projectRoot = mkdtempForTestSync('agent-device-metro-companion-legacy-');
  const statePath = path.join(projectRoot, '.agent-device', 'metro-companion.json');
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        pid: 555,
        startTime: 'start-555',
        command: `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
        serverBaseUrl: 'https://bridge.example.test',
        localBaseUrl: 'http://127.0.0.1:8081',
        tokenHash: 'legacy-token-hash',
        consumers: ['session-a'],
      })}\n`,
    );

    vi.mocked(runCmdDetached).mockReturnValueOnce(666);
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockReturnValue('start-555');
    vi.mocked(readProcessCommand).mockReturnValue(
      `${process.execPath} src/client/companion-tunnel.ts --agent-device-run-metro-companion`,
    );
    vi.mocked(waitForProcessExit).mockResolvedValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const spawned = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      consumerKey: 'session-a',
    });

    assert.equal(spawned.spawned, true);
    assert.equal(spawned.pid, 666);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 1);
    assert.deepEqual(killSpy.mock.calls[0], [555, 'SIGTERM']);
    const state = JSON.parse(fs.readFileSync(spawned.statePath, 'utf8')) as {
      bridgeScope?: unknown;
    };
    assert.deepEqual(state.bridgeScope, TEST_BRIDGE_SCOPE);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
