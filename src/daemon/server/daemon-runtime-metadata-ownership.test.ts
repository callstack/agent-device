import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { publishDaemonRegistration } from '../../__tests__/test-utils/device-claim-store.ts';

const lifecycleEvents = vi.hoisted(() => [] as string[]);
const startupFailure = vi.hoisted(() => ({ active: false }));

vi.mock('../../platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {},
      finalizeDaemonShutdown: async () => {},
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {
      lifecycleEvents.push('gateway-shutdown');
    },
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('../../provider-device-runtimes.ts', () => ({
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS: [],
  createDaemonProviderRuntimeComposition: async () => ({ runtimes: [], platformModules: [] }),
}));

// The post-lock, pre-publication step the runtime awaits first. Making it throw lands the runtime in
// the startup-failure branch that also removes `daemon.json`, which is otherwise unreachable from a
// test because every later step needs a real device toolchain.
vi.mock('../../platform-runtime-daemon-lifecycle.ts', () => ({
  platformDaemonLifecycleOwners: {
    configureForDaemonLock: async () => {
      if (startupFailure.active) throw new Error('startup step failed');
    },
    recoverLegacyAppLogMarkers: async () => ({ recovered: [], retained: [] }),
    clearDaemonLockConfiguration: async () => {},
    resetAndroidSnapshotHelper: async () => {},
  },
}));

import { startDaemonRuntime } from './daemon-runtime.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';

type DaemonPaths = ReturnType<typeof resolveDaemonPaths>;

// A pid no host can be holding, so the fabricated successor is never mistaken for a live process by
// anything that verifies identity against the process table.
const SUCCESSOR_PID = 999_999_999;

function startRuntime(stateDir: string, exit: (code: number) => void) {
  return startDaemonRuntime({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
    exit,
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
}

function logEvents(stateDir: string): Array<{ phase: string; data?: Record<string, unknown> }> {
  const logPath = path.join(stateDir, 'daemon.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> });
}

function publishSuccessor(paths: DaemonPaths): void {
  publishDaemonRegistration(paths.baseDir, { pid: SUCCESSOR_PID, startTime: 'successor-start' });
}

afterEach(() => {
  startupFailure.active = false;
  lifecycleEvents.length = 0;
  vi.restoreAllMocks();
});

test('a shutdown whose daemon.json names a successor keeps the file and logs the decline', async () => {
  // #3087: the exiting daemon used to unlink whatever daemon.json was present, deleting the serving
  // daemon's metadata and leaving every later client failing with hasInfo:false + retainedLockProcess.
  const stateDir = mkdtempForTestSync('agent-device-daemon-info-ownership-shutdown-');
  const paths = resolveDaemonPaths(stateDir);
  const exits: number[] = [];
  try {
    const runtime = await startRuntime(stateDir, (code) => exits.push(code));
    expect(runtime).not.toBeNull();

    publishSuccessor(paths);
    await runtime?.shutdown();

    expect(exits).toEqual([0]);
    expect(lifecycleEvents).toContain('gateway-shutdown');
    expect(fs.existsSync(paths.infoPath), 'the serving daemon keeps its metadata').toBe(true);
    expect(fs.existsSync(paths.lockPath), 'the exiting daemon still releases its own lock').toBe(
      false,
    );
    expect(logEvents(stateDir)).toContainEqual(
      expect.objectContaining({
        phase: 'daemon_info_removal_declined',
        data: expect.objectContaining({ reason: 'replaced', registeredPid: SUCCESSOR_PID }),
      }),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a shutdown removes its own metadata and reports an unverified release', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-info-owned-shutdown-');
  const paths = resolveDaemonPaths(stateDir);
  try {
    const runtime = await startRuntime(stateDir, () => {});
    expect(runtime).not.toBeNull();

    const originalRmdir = fs.rmdirSync;
    vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
      if (target === paths.lockPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return originalRmdir(target, options);
    });
    await runtime?.shutdown();

    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(logEvents(stateDir).map((event) => event.phase)).not.toContain(
      'daemon_info_removal_declined',
    );
    expect(logEvents(stateDir)).toContainEqual(
      expect.objectContaining({
        phase: 'daemon_registration_finish_failed',
        data: expect.objectContaining({
          error: expect.objectContaining({
            message: 'Cannot verify ownership of daemon registration',
            details: expect.objectContaining({
              lockDirPath: paths.lockPath,
              ownerReleaseUnverified: true,
            }),
            hint: expect.stringContaining('confirming all users'),
          }),
        }),
      }),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a startup that fails before publication removes no record and writes no log', async () => {
  // The other removal site. Client cleanup deletes daemon.json routinely, so this path must stay
  // silent: reporting an "absent" record here would create a daemon.log on every such startup.
  const stateDir = mkdtempForTestSync('agent-device-daemon-info-startup-absent-');
  const paths = resolveDaemonPaths(stateDir);
  const exits: number[] = [];
  startupFailure.active = true;
  try {
    const runtime = await startRuntime(stateDir, (code) => exits.push(code));

    expect(runtime).toBeNull();
    expect(exits).toEqual([1]);
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(fs.existsSync(paths.logPath), 'nothing was declined, so nothing is logged').toBe(false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a startup that fails before publication leaves a foreign record standing', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-info-startup-foreign-');
  const paths = resolveDaemonPaths(stateDir);
  const exits: number[] = [];
  publishSuccessor(paths);
  startupFailure.active = true;
  try {
    const runtime = await startRuntime(stateDir, (code) => exits.push(code));

    expect(runtime).toBeNull();
    expect(exits).toEqual([1]);
    expect(fs.existsSync(paths.infoPath)).toBe(true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a successor published during this daemon lifetime is recorded at detection', async () => {
  // The detection half of #3087: the losing daemon used to vanish without ever noting that its
  // record was gone, so the next investigation started from a truncated daemon.log. What is under test
  // is that a live runtime notices and gets it to disk; the decision itself is
  // `daemon-metadata-loss.test.ts`, which needs no daemon to answer it.
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-daemon-metadata-lost-');
  const paths = resolveDaemonPaths(stateDir);
  try {
    const runtime = await startRuntime(stateDir, () => {});
    expect(runtime).not.toBeNull();

    publishSuccessor(paths);
    await vi.runOnlyPendingTimersAsync();

    expect(logEvents(stateDir)).toContainEqual(
      expect.objectContaining({
        phase: 'daemon_metadata_lost',
        data: expect.objectContaining({ state: 'replaced', registeredPid: SUCCESSOR_PID }),
      }),
    );

    vi.useRealTimers();
    await runtime?.shutdown();
  } finally {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the loss watch is armed only after this daemon publishes its own record', () => {
  // Arming before publication would report a predecessor's record as a takeover of something this
  // daemon never owned. Ordering is the invariant, the same way the startup-ordering guards read it.
  const source = fs.readFileSync(new URL('./daemon-runtime.ts', import.meta.url), 'utf8');
  const published = source.indexOf('publishDaemonInfo(socketPort, httpPort);');
  const armed = source.indexOf('stopMetadataLossWatch = armDaemonMetadataLossWatch(');

  expect(published).toBeGreaterThanOrEqual(0);
  expect(armed).toBeGreaterThan(published);
});

test('both exits tear the watch down before they touch daemon.json', () => {
  // A watch still armed when the removal runs can report a loss for a record its own process just
  // deleted. The startup-failure half of this is unreachable from a test — everything after
  // publication needs a real toolchain — so the invariant is read off the source, the same way the
  // arming order above is.
  const source = fs.readFileSync(new URL('./daemon-runtime.ts', import.meta.url), 'utf8');
  const stopped = source.indexOf('stopMetadataLossWatch();');
  const removal = source.indexOf('await finishDaemonRegistration(');

  expect(stopped).toBeGreaterThanOrEqual(0);
  expect(removal).toBeGreaterThan(stopped);
  expect(source.match(/stopMetadataLossWatch\(\);/g)).toHaveLength(2);
});
