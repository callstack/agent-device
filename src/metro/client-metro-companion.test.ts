import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import type { AppError } from '@agent-device/kernel/errors';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
}));
// `stopProcessAndConfirmExit` is the seam this suite owns: what it proved is decided by the case
// table, and these tests assert what the companion layer does with the verdict.
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: vi.fn(),
  readProcessCommand: vi.fn(),
  readProcessStartTime: vi.fn(),
  stopProcessAndConfirmExit: vi.fn(),
}));

import { runCmdDetached } from '@agent-device/host-kit/command';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  stopProcessAndConfirmExit,
  type ConfirmedProcessStop,
} from '@agent-device/host-kit/process';

import { ensureMetroCompanion, stopMetroCompanion } from '../metro/client-metro-companion.ts';
import { ensureReactDevtoolsCompanion } from '../client/client-react-devtools-companion.ts';
import { METRO_COMPANION_RUN_ARG } from '../client/client-companion-tunnel-contract.ts';

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

/** The stops the code asked host-kit for: the identity recorded beside the pid, and the budget. */
const COMPANION_STOP_BUDGET = { termTimeoutMs: 1_000, killTimeoutMs: 1_000 };
const COMPANION_TUNNEL_COMMAND = `${process.execPath} src/client/companion-tunnel.ts ${METRO_COMPANION_RUN_ARG}`;
const UNRELATED_COMMAND = '/usr/bin/nginx -g daemon off;';
// A predicate compares by identity, so deepEqual cannot see whether it would accept the tunnel or
// refuse a stranger. Projecting its verdicts is what makes a dropped or inverted matcher fail here.
const stopRequests = () =>
  vi.mocked(stopProcessAndConfirmExit).mock.calls.map(([target, budget]) => ({
    pid: target.pid,
    startTime: target.identity.startTime,
    namesCompanion: target.identity.matches?.(COMPANION_TUNNEL_COMMAND) ?? null,
    namesStranger: target.identity.matches?.(UNRELATED_COMMAND) ?? null,
    budget,
  }));

const STOPPED: ConfirmedProcessStop = { status: 'stopped' };

/** One projected stop request, with the matcher having accepted the tunnel and refused a stranger. */
const companionStop = (pid: number, startTime: string) => ({
  pid,
  startTime,
  namesCompanion: true,
  namesStranger: false,
  budget: COMPANION_STOP_BUDGET,
});

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
    vi.mocked(stopProcessAndConfirmExit).mockResolvedValue(STOPPED);

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
    assert.equal(vi.mocked(stopProcessAndConfirmExit).mock.calls.length, 0);

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
    assert.deepEqual(stopRequests(), [companionStop(111, 'start-111')]);
    assert.equal(fs.existsSync(stagingFirst.statePath), false);
    assert.equal(fs.existsSync(stagingFirst.logPath), false);

    const prodStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/prod.json',
      consumerKey: 'session-prod',
    });
    assert.equal(prodStop.stopped, true);
    assert.deepEqual(stopRequests(), [
      companionStop(111, 'start-111'),
      companionStop(222, 'start-222'),
    ]);
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
    vi.mocked(stopProcessAndConfirmExit).mockResolvedValue(STOPPED);

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
    assert.deepEqual(stopRequests(), [companionStop(333, 'start-333')]);
    assertCompanionSpawnTarget();

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
      startTime: `start-${pid}`,
      serverBaseUrl: 'https://bridge.example.test',
      localBaseUrl: 'http://127.0.0.1:8081',
      tokenHash: 'token-hash',
      consumers: [],
    })}\n`,
  );
  return statePath;
}

type CompanionTeardownCase = Readonly<{
  name: string;
  pid: number;
  processAlive: boolean;
  processCommand: string | null;
  /** What host-kit's stop proves, or the host fault it propagates. */
  stop: ConfirmedProcessStop | { throws: Error };
  /** What the operator has to be able to read off the failure for this verdict. */
  says?: string[];
  keepsState: boolean;
}>;

const RETAINED_ON_TERM: ConfirmedProcessStop = {
  status: 'retained',
  reason: 'signal-failed',
  signal: 'SIGTERM',
  errno: 'EPERM',
};

const IDENTITY_UNVERIFIED: ConfirmedProcessStop = {
  status: 'retained',
  reason: 'identity-unverified',
};

const COMPANION_TEARDOWN_CASES: CompanionTeardownCase[] = [
  {
    name: 'clears artifacts when the host proves the recorded process is gone',
    pid: 4001,
    processAlive: false,
    processCommand: COMPANION_TUNNEL_COMMAND,
    stop: STOPPED,
    keepsState: false,
  },
  {
    // The #3540 companion: an elevated process this profile cannot describe. Dropping the state here
    // is what let a second companion start beside a live one, so the reason has to reach the operator.
    name: 'keeps the state when the host cannot verify the companion identity',
    pid: 4002,
    processAlive: true,
    processCommand: null,
    stop: IDENTITY_UNVERIFIED,
    says: ['could not be confirmed as the Metro companion', 'no signal was sent'],
    keepsState: true,
  },
  {
    // Reporting `stopped` on EPERM is what used to let a second companion start beside this one.
    name: 'keeps the state when the stop reports a refused signal',
    pid: 4003,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    stop: RETAINED_ON_TERM,
    says: ['refused SIGTERM (EPERM)', 'sudo kill 4003'],
    keepsState: true,
  },
  {
    // A fault that is not a stop outcome is not swallowed either: the state stays for the retry.
    name: 'propagates a host fault that carries no errno and keeps the state',
    pid: 4006,
    processAlive: true,
    processCommand: COMPANION_TUNNEL_COMMAND,
    stop: { throws: new TypeError('kill refused: bad signal') },
    keepsState: true,
  },
];

test.each(COMPANION_TEARDOWN_CASES)(
  'stopping a companion confirms the exit before dropping state: $name',
  async ({ pid, processAlive, processCommand, stop, says, keepsState }) => {
    const projectRoot = mkdtempForTestSync('agent-device-metro-companion-teardown-');
    const statePath = writeOwnCompanionState(projectRoot, pid);
    try {
      vi.mocked(isProcessAlive).mockReturnValue(processAlive);
      vi.mocked(readProcessCommand).mockReturnValue(processCommand);
      const stopMock = vi.mocked(stopProcessAndConfirmExit);
      if ('throws' in stop) stopMock.mockRejectedValue(stop.throws);
      else stopMock.mockResolvedValue(stop);

      if ('throws' in stop) {
        await assert.rejects(() => stopMetroCompanion({ projectRoot }), stop.throws);
      } else if (stop.status === 'retained') {
        await assert.rejects(
          () => stopMetroCompanion({ projectRoot }),
          (error: unknown) => {
            const failure = error as AppError;
            const details = failure.details;
            assert.equal(details?.reason, stop.reason);
            assert.equal(details?.signal, 'signal' in stop ? stop.signal : undefined);
            assert.equal(details?.errno, 'errno' in stop ? stop.errno : undefined);
            assert.equal(details?.pid, pid);
            for (const said of says ?? [])
              assert.ok(failure.message.includes(said), failure.message);
            return true;
          },
        );
      } else {
        assert.equal((await stopMetroCompanion({ projectRoot })).stopped, true);
      }
      // Whatever the host went on to prove, the caller handed over the identity it recorded.
      assert.deepEqual(stopRequests(), [companionStop(pid, `start-${pid}`)]);
      assert.equal(fs.existsSync(statePath), keepsState);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  },
);

test('a companion whose stop was refused keeps its state and is not replaced by a second one', async () => {
  // ensure stops before spawning, so an unconfirmed stop aborts the respawn with the state tracked.
  const pid = 4101;
  const projectRoot = mkdtempForTestSync('agent-device-metro-companion-refused-ensure-');
  const statePath = writeOwnCompanionState(projectRoot, pid);
  const before = fs.readFileSync(statePath, 'utf8');
  try {
    // The state does not match these options (different launchUrl), so ensure must stop it first.
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessCommand).mockReturnValue(COMPANION_TUNNEL_COMMAND);
    vi.mocked(readProcessStartTime).mockReturnValue('start-4101');
    vi.mocked(stopProcessAndConfirmExit).mockResolvedValue(RETAINED_ON_TERM);

    const failure = (await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://second',
      consumerKey: 'session-a',
    }).catch((error: unknown) => error)) as AppError;
    assert.equal(failure.details?.reason, 'signal-failed', String(failure));
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 0, 'no second companion was spawned');
    assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'the tracked state is untouched');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a half-spawned companion whose stop cannot be confirmed keeps its record', async () => {
  // The state write fails once after the spawn produced a pid, so the stop verdict decides whether
  // the record goes: an unconfirmed exit keeps it, with the spawn failure as the cause.
  const pid = 4201;
  const projectRoot = mkdtempForTestSync('agent-device-metro-companion-spawn-cleanup-');
  const statePath = path.join(projectRoot, '.agent-device', 'metro-companion.json');
  try {
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockReturnValue('start-4201');
    vi.mocked(readProcessCommand).mockReturnValue(COMPANION_TUNNEL_COMMAND);
    vi.mocked(stopProcessAndConfirmExit).mockResolvedValue(RETAINED_ON_TERM);
    vi.mocked(runCmdDetached).mockReturnValue(pid);
    const writeFault = Object.assign(new Error('simulated EIO'), { code: 'EIO' });
    const realWriteFileSync = fs.writeFileSync;
    let faultPending = true;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      ...rest
    ) => {
      if (faultPending && String(target) === statePath) {
        faultPending = false;
        throw writeFault;
      }
      return realWriteFileSync(target, ...rest);
    }) as typeof fs.writeFileSync);

    const failure = (await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      consumerKey: 'session-a',
    }).catch((error: unknown) => error)) as AppError;
    assert.equal(failure.details?.reason, 'signal-failed', String(failure));
    assert.equal(failure.cause, writeFault, 'the spawn failure stays the cause');
    const kept = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pid: number };
    assert.equal(kept.pid, pid, 'the profile keeps tracking the surviving pid');
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 1, 'nothing was spawned twice');

    // What the kept record is for: a later ensure stops that same pid instead of registering a
    // second companion beside the one that refused to die.
    vi.mocked(stopProcessAndConfirmExit).mockClear();
    const retry = (await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://second',
      consumerKey: 'session-a',
    }).catch((error: unknown) => error)) as AppError;
    assert.equal(retry.details?.reason, 'signal-failed', String(retry));
    assert.deepEqual(stopRequests(), [companionStop(pid, `start-${pid}`)]);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 1, 'the retry did not spawn either');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

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
    vi.mocked(stopProcessAndConfirmExit).mockResolvedValue(STOPPED);

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
    assert.deepEqual(stopRequests(), [companionStop(555, 'start-555')]);
    const state = JSON.parse(fs.readFileSync(spawned.statePath, 'utf8')) as {
      bridgeScope?: unknown;
    };
    assert.deepEqual(state.bridgeScope, TEST_BRIDGE_SCOPE);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
