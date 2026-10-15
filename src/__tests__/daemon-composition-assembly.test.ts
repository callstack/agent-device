import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { WEB_DESKTOP_DEVICE } from '@agent-device/test-kit/device-fixtures';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { createDaemonRuntimeDeps } from '../daemon-composition.ts';
import { startDaemonRuntimeFixture } from './daemon-composition/daemon-runtime-fixture.ts';
import type { DaemonRuntimeDepsInput } from '@agent-device/daemon';

// The server builds its own store, so capture that instance the same way the shutdown tests do:
// the proof is about the store the server hands to the composition callbacks, not one the test
// fabricates.
const storeProbe = vi.hoisted(() => ({
  store: undefined as import('@agent-device/daemon/testing/session-store').SessionStore | undefined,
}));
vi.mock('@agent-device/daemon/testing/session-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/daemon/testing/session-store')>();
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

/**
 * The one-assembly guarantee (#3431 review): the server owns the paths, the ADR 0029 policy load,
 * the session store, and the `assertShutdownAllowed` derivation, and passes them to the root's
 * factory. This boots the real `startDaemonRuntime` with the real `createDaemonRuntimeDeps` —
 * wrapped only to capture what the server derived — so a server that dropped the derivation,
 * loaded no policy, or wired the session callbacks to a different store fails here.
 */
test('the server derives the policy gate and session callbacks and hands them to the root factory', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-assembly-');
  const policyPath = path.join(stateDir, 'policy.json');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ version: 1, capabilities: { deny: ['device-shutdown'] } }),
  );
  const paths = resolveDaemonPaths(stateDir);
  const exits: number[] = [];
  let composed: DaemonRuntimeDepsInput | undefined;
  const composeDeps = async (input: DaemonRuntimeDepsInput) => {
    composed = input;
    return await createDaemonRuntimeDeps(input);
  };
  let runtime: Awaited<ReturnType<typeof startDaemonRuntimeFixture>> = null;
  try {
    runtime = await startDaemonRuntimeFixture({
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
      composeDeps,
    });
    assert.notEqual(runtime, null, 'the real assembly must boot');
    assert.deepEqual(exits, []);
    assert.ok(composed, 'the server must call the factory');
    // The server resolved the paths and loaded the operator's policy before composing anything.
    assert.equal(composed.baseDir, paths.baseDir);
    assert.equal(composed.sessionsDir, paths.sessionsDir);
    // The shutdown gate the root threads into the runtime gateway refuses the denied capability.
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
  let runtime: Awaited<ReturnType<typeof startDaemonRuntimeFixture>> = null;
  try {
    runtime = await startDaemonRuntimeFixture({
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
        return await createDaemonRuntimeDeps(input);
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
