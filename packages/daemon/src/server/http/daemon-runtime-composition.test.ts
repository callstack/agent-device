import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import {
  DAEMON_STARTUP_EXIT_CODES,
  tryAcquireDaemonRegistration,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { IOS_SIMULATOR, WEB_DESKTOP_DEVICE } from '@agent-device/test-kit/device-fixtures';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import {
  installInteractorResolution,
  interactorResolution,
} from '../../core/interactor-resolution.ts';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime, type DaemonRuntimeDepsInput } from './daemon-runtime.ts';

// The server builds its own store, so capture that instance: the proof is about the store the
// server hands to the composition callbacks, not one the test fabricates.
const storeProbe = vi.hoisted(() => ({
  store: undefined as import('../../core/session-store.ts').SessionStore | undefined,
}));
vi.mock('../../core/session-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/session-store.ts')>();
  return {
    ...actual,
    SessionStore: class extends actual.SessionStore {
      constructor(...args: ConstructorParameters<typeof actual.SessionStore>) {
        super(...args);
        storeProbe.store = this;
      }
    },
  };
});

test('daemon startup installs the interactor resolution the composition supplied', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-interactor-composition-');
  const composed = Object.freeze({ resolve: vi.fn(async () => ({}) as never) });
  const previousResolution = interactorResolution();
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;
  try {
    runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
      composeDeps: daemonRuntimeDepsFixture({ interactorResolution: composed }),
    });
    expect(runtime).not.toBeNull();

    expect(interactorResolution()).toBe(composed);
    await interactorResolution().resolve(IOS_SIMULATOR, {});
    expect(composed.resolve).toHaveBeenCalledOnce();
  } finally {
    await runtime?.shutdown();
    installInteractorResolution(previousResolution);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a daemon attempt losing the lock shuts down every constructed provider', async () => {
  const stateDir = mkdtempForTestSync('daemon-held-lock-');
  const held = await tryAcquireDaemonRegistration(resolveDaemonPaths(stateDir));
  if (held.status !== 'acquired') throw new Error('registration fixture refused');
  const shutdown = vi.fn(() => {
    throw new Error('cleanup failed');
  });
  const otherShutdown = vi.fn(async () => {});
  const exit = vi.fn();
  const runtime = await startDaemonRuntime({
    env: { AGENT_DEVICE_STATE_DIR: stateDir },
    exit,
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: daemonRuntimeDepsFixture({
      providerDeviceRuntimes: [shutdown, otherShutdown].map(
        (stop, index) =>
          ({
            provider: `fixture-${index}`,
            shutdown: stop,
            leaseLifecycle: {},
          }) as unknown as ProviderDeviceRuntime,
      ),
    }),
  });
  expect(runtime).toBeNull();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(otherShutdown).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(DAEMON_STARTUP_EXIT_CODES.busy);
  await held.owner.finish();
});

/**
 * The one-assembly guarantee (#3431 review): the server owns the paths, the ADR 0029 policy load,
 * the session store, and the `assertShutdownAllowed` derivation, and passes them to the
 * composition factory. A server that dropped the derivation, loaded no policy, or wired the session
 * callbacks to a different store fails here.
 */
test('the server derives the policy gate and session callbacks and hands them to the composition', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-assembly-');
  const policyPath = path.join(stateDir, 'policy.json');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ version: 1, capabilities: { deny: ['device-shutdown'] } }),
  );
  const paths = resolveDaemonPaths(stateDir);
  const exits: number[] = [];
  let composed: DaemonRuntimeDepsInput | undefined;
  const fixtureDeps = daemonRuntimeDepsFixture();
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;
  try {
    runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_POLICY: policyPath,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: (code) => exits.push(code),
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
      composeDeps: async (input) => {
        composed = input;
        return await fixtureDeps(input);
      },
    });
    assert.notEqual(runtime, null, 'the assembly must boot');
    assert.deepEqual(exits, []);
    assert.ok(composed, 'the server must call the factory');
    // The server resolved the paths and loaded the operator's policy before composing anything.
    assert.equal(composed.baseDir, paths.baseDir);
    assert.equal(composed.sessionsDir, paths.sessionsDir);
    // The shutdown gate the composition threads into the runtime gateway refuses the denied capability.
    assert.throws(
      () => composed?.assertShutdownAllowed?.(),
      (error: unknown) =>
        (error as { details?: { reason?: string; rule?: string } }).details?.reason ===
          'DAEMON_POLICY_DENIED' &&
        (error as { details?: { rule?: string } }).details?.rule === 'capability',
    );
    // The web-session callback reads the one store the server built, so the deps closures and the
    // server can never disagree about which sessions are open.
    const store = storeProbe.store;
    assert.ok(store, 'the server must construct the store the callbacks read');
    store.publish('web-assembly', {
      name: 'web-assembly',
      device: WEB_DESKTOP_DEVICE,
      createdAt: Date.now(),
      actions: [],
    });
    assert.deepEqual([...composed.openWebSessionNames()], ['web-assembly']);
    assert.equal(
      composed.resolveSessionDir('web-assembly'),
      store.resolveSessionDir('web-assembly'),
    );
    assert.deepEqual(composed.resolveSessionArtifacts('web-assembly'), {
      outputPath: store.resolveAppLogPath('web-assembly'),
      pidPath: store.resolveAppLogPidPath('web-assembly'),
    });
    await runtime?.shutdown();
    runtime = null;
    assert.deepEqual(exits, [0]);
  } finally {
    await runtime?.shutdown();
  }
});

/**
 * A policy the operator names but that cannot be read stops startup through the same server,
 * before any runtime is composed: the typed stderr and exit are the server's, not the entry's.
 */
test('an unreadable policy stops the assembly before the factory is called', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-assembly-bad-policy-');
  const exits: number[] = [];
  const stderr: string[] = [];
  let factoryCalls = 0;
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> = null;
  try {
    runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_POLICY: path.join(stateDir, 'missing-policy.json'),
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: (code) => exits.push(code),
      stderr: { write: (chunk) => stderr.push(chunk) },
      stdout: { write: () => {} },
      registerProcessHandlers: false,
      composeDeps: async (input) => {
        factoryCalls += 1;
        return await daemonRuntimeDepsFixture()(input);
      },
    });
    assert.equal(runtime, null);
    assert.deepEqual(exits, [1]);
    assert.equal(factoryCalls, 0, 'no runtime may be built under an unreadable policy');
    assert.match(stderr.join(''), /Daemon error: .*/);
  } finally {
    await runtime?.shutdown();
  }
});
