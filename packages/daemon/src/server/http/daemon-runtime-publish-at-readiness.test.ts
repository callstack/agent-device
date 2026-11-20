import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  daemonRuntimeDepsFixture,
  platformOwnerLifecycleFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

// Startup order is the contract here, so these boot the real runtime and read what it leaves on disk:
// when `daemon.json` appears, and what `daemon.log` holds at each step. The gate holds startup inside
// the host-global device-claim sweep, which is the last thing a ready daemon must have done.
const probe = vi.hoisted(() => ({
  /** When set, device-claim reconciliation waits here so a test can inspect a mid-startup state dir. */
  reconcileGate: undefined as Promise<void> | undefined,
}));

vi.mock('@agent-device/daemon-contracts/device-claims', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/daemon-contracts/device-claims')>();
  return {
    ...actual,
    reconcileOrphanedDeviceClaims: async (
      ...args: Parameters<typeof actual.reconcileOrphanedDeviceClaims>
    ) => {
      if (probe.reconcileGate) await probe.reconcileGate;
      return await actual.reconcileOrphanedDeviceClaims(...args);
    },
  };
});

const stateDirs: string[] = [];
const silent = { stderr: { write: () => {} }, stdout: { write: () => {} } };

function hostFor(stateDir: string, env: Record<string, string> = {}) {
  return createTestHostEnvironment({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      // The sweep is host-global, so a suite that runs it must point it at its own directory.
      AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims'),
      ...env,
    },
  });
}

/** A state directory holding a state dir, an empty claims root, and a log from an earlier run. */
function stateDirWithStaleLog(): { dir: string; paths: ReturnType<typeof resolveDaemonPaths> } {
  const dir = mkdtempForTestSync('agent-device-daemon-publish-');
  stateDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'claims'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'daemon.log'), 'earlier daemon: device on fire\n'.repeat(40));
  return { dir, paths: resolveDaemonPaths(dir) };
}

afterEach(() => {
  probe.reconcileGate = undefined;
  while (stateDirs.length > 0) {
    fs.rmSync(stateDirs.pop()!, { recursive: true, force: true });
  }
});

test('the registration lands only after device-claim reconciliation finished', async () => {
  const { dir, paths } = stateDirWithStaleLog();
  let openGate: () => void = () => {};
  probe.reconcileGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const starting = startDaemonRuntime({
    host: hostFor(dir),
    ...silent,
    composeDeps: daemonRuntimeDepsFixture(),
  });
  try {
    // The sweep is still running, so the state directory may not advertise this daemon: a client that
    // read the record would connect and be admitted while a device its own sweep is about to settle
    // still looked claimed, or unclaimed, from the wrong side of that decision.
    for (let polls = 0; polls < 20; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(paths.infoPath), 'record before readiness').toBe(false);
    }
    // The lock is held throughout, so a contender waits instead of starting a second runtime.
    expect(fs.existsSync(paths.lockPath), 'held lock mid-startup').toBe(true);

    openGate();
    const runtime = await starting;
    expect(fs.existsSync(paths.infoPath), 'record at readiness').toBe(true);
    await runtime.close();
  } finally {
    openGate();
    await starting.then((runtime) => runtime?.close().catch(() => {}));
  }
});

test('the winner empties the log when it wins the lock, so startup writes before publication survive', async () => {
  const { dir, paths } = stateDirWithStaleLog();
  const before = fs.statSync(paths.logPath);
  // The detached launch redirects the daemon's stdout and stderr to this inode and keeps the handle
  // open for the whole run, so this is how a real startup reaches the log before it publishes.
  const launchHandle = fs.openSync(paths.logPath, 'a');
  try {
    const runtime = await startDaemonRuntime({
      host: hostFor(dir),
      ...silent,
      composeDeps: daemonRuntimeDepsFixture({
        ownerLifecycle: platformOwnerLifecycleFixture({
          configureForDaemonLock: async () => {
            fs.writeSync(launchHandle, 'startup: recovered two orphaned app-log markers\n');
          },
        }),
      }),
    });
    try {
      const log = fs.readFileSync(paths.logPath, 'utf8');
      // The earlier run's content is gone, and this startup's own line is not: publication no longer
      // truncates, so the file a launcher or client reads back holds the startup it describes.
      expect(log).not.toContain('device on fire');
      expect(log).toBe('startup: recovered two orphaned app-log markers\n');
      // Emptied in place: the redirect the launch opened, and anything else holding the file, still
      // point at this inode.
      const after = fs.statSync(paths.logPath);
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBeLessThan(before.size);
    } finally {
      await runtime.close();
    }
  } finally {
    fs.closeSync(launchHandle);
  }
});

test('a start that fails after the reset releases the lock and leaves the log it wrote readable', async () => {
  const { dir, paths } = stateDirWithStaleLog();
  const launchHandle = fs.openSync(paths.logPath, 'a');
  try {
    const failure = new Error('startup step failed after the lock');
    await expect(
      startDaemonRuntime({
        host: hostFor(dir),
        ...silent,
        composeDeps: daemonRuntimeDepsFixture({
          ownerLifecycle: platformOwnerLifecycleFixture({
            configureForDaemonLock: async () => {
              fs.writeSync(launchHandle, 'startup: configuring platform owners\n');
            },
            recoverLegacyAppLogMarkers: async () => {
              throw failure;
            },
          }),
        }),
      }),
    ).rejects.toBe(failure);

    // Nothing was published, and the lock this startup won is the lock it gave back.
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    // The log it is left with describes the start that failed, not the one before it. The executable
    // writes the failure line to stderr, which the launch redirects into this same file.
    expect(fs.readFileSync(paths.logPath, 'utf8')).toBe('startup: configuring platform owners\n');
  } finally {
    fs.closeSync(launchHandle);
  }
});
