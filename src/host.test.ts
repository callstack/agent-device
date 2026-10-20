// `startAgentDevice`, end to end: an embedder starts the runtime inside its own process and gets a
// client, a config another process attaches with, and one close. The host here is the test process,
// which is what makes the central assertion cheap and final: a code path that reached for a signal, or
// for `process.exit`, would take the test runner down with it.

import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readDaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { builtinPluginInventory } from './__tests__/test-utils/builtin-plugin-inventory.ts';
import { stopRecordedDaemon } from './daemon-client/daemon-client-stop.ts';
import * as daemonLaunchSpec from './daemon-client/daemon-launch-spec.ts';
import { startAgentDevice } from './host.ts';

const composition = vi.hoisted(() => ({
  /** The candidates a host handed the embedded composition, so a row can see what it passed on. */
  embedderCandidates: undefined as unknown[] | undefined,
}));

// The platform and provider modules are stand-ins in this file: what these rows judge is the entry's
// own decisions — what it publishes, what it refuses, what it never touches — not the device runtimes.
vi.mock('./platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => [],
      finalizeDaemonShutdown: async () => [],
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => [],
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('./provider-device-runtimes.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-device-runtimes.ts')>();
  return {
    ...actual,
    createDaemonProviderRuntimeComposition: async () => {
      // A host names its plugins in code, so the store that `plugin add` writes is not one of its
      // sources. Reaching it would let somebody else's install change what this process runs.
      throw new Error('a host never reads the plugin store');
    },
    createEmbeddedProviderRuntimeComposition: async (
      _env: unknown,
      embedderCandidates: readonly PluginCandidate[],
    ) => {
      composition.embedderCandidates = [...embedderCandidates];
      const { resolveProviderPlugins } = await import('@agent-device/plugins/registry');
      const resolved = await resolveProviderPlugins(embedderCandidates);
      return {
        runtimes: [],
        platformModules: [],
        shutdown: async () => [],
        inventory: [
          ...(await (
            await import('./__tests__/test-utils/builtin-plugin-inventory.ts')
          ).builtinPluginInventory()),
          ...resolved.inventory(),
        ],
      };
    },
  };
});

import type { AgentDeviceHost } from './sdk/host-types.ts';

type Booted = {
  stateDir: string;
  paths: ReturnType<typeof resolveDaemonPaths>;
  host: AgentDeviceHost;
};

async function bootHost(
  options: {
    plugins?: readonly import('@agent-device/plugins/contract').AgentDevicePlugin[];
    env?: Record<string, string>;
  } = {},
): Promise<Booted> {
  const { env, ...startOptions } = options;
  const stateDir = mkdtempForTestSync('agent-device-host-entry-');
  const host = await startAgentDevice({
    stateDir,
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        ...(env ?? {}),
      },
    }),
    ...startOptions,
  });
  return { stateDir, paths: resolveDaemonPaths(host.clientConfig.stateDir!), host };
}

function removeStateDir(stateDir: string) {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

test('a host publishes its own process as the runtime an outside stop must not signal', async () => {
  const { stateDir, paths, host } = await bootHost();
  try {
    const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
      pid: number;
      ownership?: string;
      transport?: string;
    };
    // The record names the test process, which is why every stop route must ask instead of signaling.
    expect(record.pid).toBe(process.pid);
    expect(record.ownership).toBe('embedded');
    expect(readDaemonStopIdentity(paths.infoPath).ownership).toBe('embedded');
  } finally {
    await host.close();
    removeStateDir(stateDir);
  }
});

test('an installed host publishes no checkout code signature', async () => {
  const identity = vi
    .spyOn(daemonLaunchSpec, 'resolveLocalDaemonCodeIdentity')
    .mockResolvedValue({ origin: 'installed' });
  try {
    const { stateDir, paths, host } = await bootHost();
    try {
      const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8'));
      expect(record.codeOrigin).toBe('installed');
      expect(record).not.toHaveProperty('codeSignature');
    } finally {
      await host.close();
      removeStateDir(stateDir);
    }
  } finally {
    identity.mockRestore();
  }
});

test('a host hands out the pin that reaches exactly its own instance', async () => {
  const { stateDir, paths, host } = await bootHost();
  try {
    const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
      token: string;
      pid: number;
      processStartTime?: string;
    };
    // The pin is the record's own triple, so an attacher that resolves a different working directory
    // still addresses this instance rather than whatever holds the directory next.
    expect(host.clientConfig.daemonBinding).toEqual({
      token: record.token,
      pid: record.pid,
      processStartTime: readProcessStartTime(process.pid),
    });
    expect(host.clientConfig.daemonLifecycle).toBe('attach');
    // The resolved absolute directory, so an attacher with another working directory addresses this
    // daemon rather than resolving a relative path against its own cwd.
    expect(host.clientConfig.stateDir).toBe(paths.baseDir);
  } finally {
    await host.close();
    removeStateDir(stateDir);
  }
});

test('a host runs its runtime on the socket its client is given, whatever the process exports', async () => {
  // An embedder's process may carry a server mode for other purposes. The host cannot honour it: the
  // config it hands out names a socket, and a runtime started in `http` mode opens no socket listener
  // at all, so the host's own client could not reach the runtime this call started.
  const { stateDir, paths, host } = await bootHost({
    env: { AGENT_DEVICE_DAEMON_SERVER_MODE: 'http' },
  });
  try {
    const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
      transport?: string;
      port?: number;
      httpPort?: number;
    };
    expect(record.transport).toBe('socket');
    expect(typeof record.port).toBe('number');
    expect(record.httpPort).toBeUndefined();
    // The client of the host that started this runtime reaches it over that socket, which is the whole
    // promise. A record that names no socket makes this fail instead.
    await expect(host.client.sessions.list()).resolves.toBeInstanceOf(Array);
  } finally {
    await host.close();
    removeStateDir(stateDir);
  }
});

test('a host registers the plugins its embedder imported and reports the inventory', async () => {
  const plugin = {
    apiVersion: 2 as const,
    provider: 'embedder-plugin',
    credentials: { variables: [] },
    setup: async () => {
      throw new Error('not invoked by composition fixture');
    },
  };
  const { stateDir, paths, host } = await bootHost({ plugins: [plugin] });
  try {
    // The embedder's objects reach the composition as candidates the registry claims in order, and the
    // store is never consulted: a plugin somebody installed later cannot change this process.
    expect(composition.embedderCandidates).toEqual([
      { source: 'embedder', load: expect.any(Function) },
    ]);
    expect(JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')).plugins).toEqual([
      ...(await builtinPluginInventory()),
      expect.objectContaining({ provider: 'embedder-plugin', state: 'active', source: 'embedder' }),
    ]);
  } finally {
    await host.close();
    removeStateDir(stateDir);
  }
});

test.each([
  { plugin: 'not-a-plugin', reason: 'invalid_plugin' },
  { plugin: { apiVersion: 1, provider: 'wrong-version' }, reason: 'incompatible_plugin' },
])(
  'plugin validation reports $reason through the registry inventory',
  async ({ plugin, reason }) => {
    const { stateDir, paths, host } = await bootHost({
      // @ts-expect-error malformed JavaScript input
      plugins: [plugin],
    });
    try {
      expect(JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')).plugins).toContainEqual(
        expect.objectContaining({
          source: 'embedder',
          state: 'failed',
          error: expect.objectContaining({ reason }),
        }),
      );
      expect(fs.existsSync(paths.infoPath)).toBe(true);
    } finally {
      await host.close();
      removeStateDir(stateDir);
    }
  },
);

test('a host without a state directory is refused, never a daemon in an inherited one', async () => {
  for (const stateDir of [undefined, '', '   ']) {
    const refusal = await startAgentDevice({
      stateDir: stateDir as string,
      host: createTestHostEnvironment({
        env: { AGENT_DEVICE_STATE_DIR: '/tmp/agent-device-host-entry-inherited' },
      }),
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; details?: { reason?: string } },
    );

    // An ambient variable is not a choice: a host that inherited one would attach to, or claim, a
    // directory nobody picked for this process.
    expect(refusal, JSON.stringify(stateDir)).toMatchObject({
      code: 'INVALID_ARGS',
      details: {
        reason: 'host_state_dir_required',
        hint: 'Pass an explicit stateDir to startAgentDevice({ stateDir }).',
      },
    });
  }
  expect(fs.existsSync('/tmp/agent-device-host-entry-inherited/daemon.json')).toBe(false);
});

test('a host ends its own runtime once, and an outside stop ends it the same way', async () => {
  const { stateDir, paths, host } = await bootHost();
  const signals = vi.spyOn(process, 'kill');
  const exit = vi.spyOn(process, 'exit');

  try {
    // Concurrent and repeated closes share one teardown, and none of them exits the process: a library
    // a test runner imported cannot claim the executable's lifetime.
    const [first, second] = await Promise.all([host.close(), host.close()]);
    await expect(host.close()).resolves.toEqual(first);

    expect(first).toEqual(second);
    expect(exit).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      requests: { drained: 0, abandoned: 0 },
      plugins: { failed: [], pending: [] },
    });
    // One close wrote one answer: the registration is gone and nothing is left to stop.
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(hostSignals(signals)).toEqual([]);

    // A stop that arrives afterwards finds an empty state directory, which is the whole point of the
    // record being the host's own: it reports what the host already did.
    const stopped = await stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
      paths,
      host: createTestHostEnvironment(),
    });
    expect(stopped).toMatchObject({ stopped: false, mode: 'not-running' });
  } finally {
    signals.mockRestore();
    exit.mockRestore();
    await host.close();
    removeStateDir(stateDir);
  }
});

test("an operator's stop tears a host's runtime down exactly as its own close would", async () => {
  const { stateDir, paths, host } = await bootHost();
  const signals = vi.spyOn(process, 'kill');

  try {
    const stopped = await stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
      paths,
      host: createTestHostEnvironment(),
    });

    // The runtime answered with its own close: asked over its transport, never signaled.
    expect(stopped).toMatchObject({ stopped: true, mode: 'graceful' });
    expect(hostSignals(signals)).toEqual([]);
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    // The host learns the same report it would have from closing itself, and closing again is not an
    // error — the case of a scope that closes after an operator already stopped the runtime.
    const report = await host.close();
    expect(report).toMatchObject({
      requests: { drained: 0, abandoned: 0 },
      platformOwners: 'closed',
      sessions: { closed: 0, failed: 0 },
      runners: { stopped: [], handedOff: [] },
      plugins: { failed: [], pending: [] },
    });
    await expect(host.close()).resolves.toEqual(report);
  } finally {
    signals.mockRestore();
    await host.close();
    removeStateDir(stateDir);
  }
});

test('a host never takes a state directory somebody else holds', async () => {
  const held = await bootHost();
  try {
    const refusal = await startAgentDevice({
      stateDir: held.stateDir,
      host: createTestHostEnvironment(),
    }).then(
      () => null,
      (error: unknown) =>
        error as { code?: string; details?: { reason?: string; stateDir?: string } },
    );

    expect(refusal).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'daemon_registration_refused', status: 'busy' },
    });
    // Refusing left the first host untouched: same runtime, same record, still attachable.
    expect(readDaemonStopIdentity(held.paths.infoPath).ownership).toBe('embedded');
  } finally {
    await held.host.close();
    removeStateDir(held.stateDir);
  }
});

/**
 * The signals this code sent at a process. `0` is a liveness probe and is not one; a call with no
 * signal argument is SIGTERM, so an omitted signal counts as the signal it really is.
 */
function hostSignals(killSpy: { mock: { calls: Array<unknown[]> } }) {
  return killSpy.mock.calls.filter(([, signal]) => signal !== 0);
}
