import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  connectionWorkspace,
  createTestClient,
  forceConnectFlags,
  metroPrepareResult,
  recordedLeaseAllocate,
  recordedLeaseRelease,
  seedConnectionState,
  seedPreviousConnection,
  unexpectedCommandCall,
  writeReplacedProfiles,
} from './remote-connection.fixtures.ts';

vi.mock('../metro/client-metro-companion.ts', () => ({
  stopMetroCompanion: vi.fn(),
}));

vi.mock('../client/client-react-devtools-companion.ts', () => ({
  stopReactDevtoolsCompanion: vi.fn(),
}));

import {
  connectCommand,
  connectionCommand,
  disconnectCommand,
} from '../cli/commands/connection.ts';
import { writeGeneratedRemoteConfig } from '../cli/connection/generated-config.ts';
import {
  hasDeferredMetroConfig,
  materializeRemoteConnectionForCommand,
  CLOUD_WEBDRIVER_REMOTE_LEASE_TTL_MS,
  PROXY_REMOTE_LEASE_TTL_MS,
} from '../cli/commands/connection-runtime.ts';
import { stopMetroCompanion } from '../metro/client-metro-companion.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import type { AgentDeviceClient } from '../agent-device-client.ts';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('deferred Metro config ignores perf-style kind values', () => {
  assert.equal(
    hasDeferredMetroConfig({
      json: true,
      help: false,
      version: false,
      kind: 'memgraph',
    }),
    false,
  );
  assert.equal(
    hasDeferredMetroConfig({
      json: true,
      help: false,
      version: false,
      metroKind: 'repack',
    }),
    true,
  );
});

test('connect auto-generates a local session and writes minimal remote state', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace('agent-device-connect-');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({ daemonBaseUrl: 'https://daemon.example.test' }),
  );

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl:
          'https://user:pass@daemon.example.test/agent-device?token=redacted&apiKey=redacted&tenant=acme',
        tenant: 'acme',
        sessionIsolation: 'tenant',
        runId: 'run-123',
      },
      client: createTestClient(),
    });
  });

  const state = readActiveConnectionState({ stateDir });
  assert.match(state?.session ?? '', /^adc-[a-z0-9]+$/);
  assert.equal(state?.leaseId, undefined);
  assert.equal(state?.leaseBackend, undefined);
  assert.equal(state?.remoteConfigHash, hashRemoteConfigFile(remoteConfigPath));
  assert.deepEqual(state?.daemon, {
    baseUrl: 'https://daemon.example.test/agent-device?tenant=acme',
  });
  assert.equal(state?.metro, undefined);
  assert.equal(state?.runtime, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect proxy writes normal remote state with generated non-secret profile', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-proxy-');

  await captureStdout(async () => {
    await connectCommand({
      positionals: ['proxy'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        daemonBaseUrl: 'http://proxy.example.test/agent-device',
        daemonAuthToken: 'proxy-secret',
        metroBearerToken: 'metro-bearer-secret',
        platform: 'android',
      },
      client: createTestClient(),
    });
  });

  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  assert.match(state.session, /^adc-[a-z0-9]+$/);
  assert.equal(state.tenant, 'proxy');
  assert.match(state.runId, /^proxy-[a-f0-9]{16}$/);
  assert.equal(state.leaseProvider, 'proxy');
  assert.match(state.clientId ?? '', /^[a-f0-9]{16}$/);
  assert.equal(state.leaseBackend, 'android-instance');
  assert.equal(state.leaseId, undefined);
  assert.deepEqual(state.daemon, {
    baseUrl: 'http://proxy.example.test/agent-device',
    transport: 'http',
  });
  assert.match(state.remoteConfigPath, /remote-connections\/generated\/proxy-[a-f0-9]{16}\.json$/);
  const generated = JSON.parse(fs.readFileSync(state.remoteConfigPath, 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(generated.daemonBaseUrl, 'http://proxy.example.test/agent-device');
  assert.equal(generated.daemonAuthToken, undefined);
  assert.equal(generated.metroBearerToken, undefined);
  assert.equal(generated.leaseProvider, 'proxy');
  assert.equal(generated.leaseTtlMs, undefined);
  assert.equal(JSON.stringify(generated).includes('proxy-secret'), false);
  assert.equal(JSON.stringify(generated).includes('metro-bearer-secret'), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect daemon-base-url shortcut uses proxy profile for direct proxy URLs', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-proxy-shortcut-');

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        daemonBaseUrl: 'http://127.0.0.1:4310/agent-device',
        daemonAuthToken: 'proxy-secret',
      },
      client: createTestClient(),
    });
  });

  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  assert.equal(state.tenant, 'proxy');
  assert.equal(state.leaseProvider, 'proxy');
  assert.match(state.clientId ?? '', /^[a-f0-9]{16}$/);
  assert.deepEqual(state.daemon, {
    baseUrl: 'http://127.0.0.1:4310/agent-device',
    transport: 'http',
  });
  assert.equal(state.leaseId, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect proxy scopes generated client identity by explicit session', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-proxy-sessions-');

  for (const session of ['agent-a', 'agent-b']) {
    await captureStdout(async () => {
      await connectCommand({
        positionals: ['proxy'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          daemonBaseUrl: 'http://proxy.example.test/agent-device',
          platform: 'android',
          session,
        },
        client: createTestClient(),
      });
    });
  }

  const first = readRemoteConnectionState({ stateDir, session: 'agent-a' });
  const second = readRemoteConnectionState({ stateDir, session: 'agent-b' });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.clientId, second.clientId);
  assert.notEqual(first.runId, second.runId);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect proxy notice distinguishes safe inventory from lease allocation', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-proxy-notice-');

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: ['proxy'],
      flags: {
        json: false,
        help: false,
        version: false,
        stateDir,
        daemonBaseUrl: 'http://proxy.example.test/agent-device',
        platform: 'android',
      },
      client: createTestClient(),
    });
  });

  assert.match(stdout, /No live device session has been created/);
  assert.match(stdout, /Run devices to inspect inventory without allocating/);
  assert.match(stdout, /agent-device open <package-id> --relaunch/);
  assert.doesNotMatch(stdout, /snapshot/);
  assert.doesNotMatch(stdout, /install-from-source/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('generated remote config writer strips secret fields', () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-generated-profile-');
  const configPath = writeGeneratedRemoteConfig({
    stateDir,
    provider: 'proxy',
    profile: {
      daemonBaseUrl: 'http://proxy.example.test/agent-device',
      daemonAuthToken: 'proxy-secret',
      metroBearerToken: 'metro-bearer-secret',
      leaseProvider: 'proxy',
      clientId: 'client-a',
    },
  });

  const generated = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(generated.daemonBaseUrl, 'http://proxy.example.test/agent-device');
  assert.equal(generated.daemonAuthToken, undefined);
  assert.equal(generated.metroBearerToken, undefined);
  assert.equal(generated.leaseProvider, 'proxy');
  assert.equal(JSON.stringify(generated).includes('proxy-secret'), false);
  assert.equal(JSON.stringify(generated).includes('metro-bearer-secret'), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect proxy rejects remote-config and unknown provider combinations', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-errors-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');

  await assert.rejects(
    async () =>
      await connectCommand({
        positionals: ['proxy'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
        },
        client: createTestClient(),
      }),
    /mutually exclusive/,
  );

  await assert.rejects(
    async () =>
      await connectCommand({
        positionals: ['wat'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
        },
        client: createTestClient(),
      }),
    /Supported providers: cloud, proxy, browserstack, aws-device-farm/,
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect reports deferred Metro runtime preparation when remote config has Metro settings', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-metro-notice-',
  );
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      metroPublicBaseUrl: 'https://sandbox.example.test',
      metroProxyBaseUrl: 'https://proxy.example.test',
    }),
  );

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example.test',
        tenant: 'acme',
        runId: 'run-123',
        platform: 'android',
      },
      client: createTestClient(),
    });
  });

  assert.match(stdout, /No live device session has been created/);
  assert.match(stdout, /Run a device command when ready/);
  assert.match(stdout, /Metro runtime is not prepared yet/);
  assert.match(stdout, /metro prepare --remote-config/);
  const connected = readActiveConnectionState({ stateDir });
  assert.equal(connected?.runtime, undefined);

  // The deferred-runtime notice is a runnable command like any next step: an
  // unscoped `metro prepare` would resolve against whichever connection is
  // host-global active, which on a shared host is another process's.
  const session = connected?.session ?? '';
  assert.ok(session);
  assert.match(stdout, new RegExp(`metro prepare --remote-config \\S+ --session ${session}\\b`));
  assert.equal(
    readRemoteConnectionState({ stateDir, session })?.remoteConfigPath,
    remoteConfigPath,
    'the emitted --session resolves back to the connection that printed the notice',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection status re-emits the deferred Metro command scoped to the named session', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connection-status-metro-',
  );
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      metroPublicBaseUrl: 'https://sandbox.example.test',
    }),
  );

  await connectCommand({
    positionals: [],
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example.test',
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      session: 'adc-status-metro',
    },
    client: createTestClient(),
  });

  const stdout = await captureStdout(async () => {
    await connectionCommand({
      positionals: ['status'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        session: 'adc-status-metro',
      },
      client: createTestClient(),
    });
  });

  const payload = JSON.parse(stdout) as { data: { runtimePreparation?: { nextStep?: string } } };
  assert.equal(
    payload.data.runtimePreparation?.nextStep,
    `agent-device metro prepare --remote-config ${remoteConfigPath} --session adc-status-metro`,
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect without a session creates a fresh connection without replacing the active one', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-idempotent-',
  );
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({ daemonBaseUrl: 'https://daemon.example.test' }),
  );

  const connectFlags = {
    json: true,
    help: false,
    version: false,
    stateDir,
    remoteConfig: remoteConfigPath,
    daemonBaseUrl: 'https://daemon.example.test',
    tenant: 'acme',
    sessionIsolation: 'tenant' as const,
    runId: 'run-123',
  };

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: connectFlags,
      client: createTestClient(),
    });
  });
  const firstState = readActiveConnectionState({ stateDir });

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: connectFlags,
      client: createTestClient(),
    });
  });
  const secondState = readActiveConnectionState({ stateDir });
  const storedSessions = fs
    .readdirSync(path.join(stateDir, 'remote-connections'))
    .filter((entry) => entry.endsWith('.json') && entry !== '.active-session.json');

  assert.notEqual(secondState?.session, firstState?.session);
  assert.equal(storedSessions.length, 2);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: firstState?.session ?? '' })?.remoteConfigPath,
    remoteConfigPath,
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect missing scope errors mention remote config or flags', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-scope-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));

  await assert.rejects(
    async () =>
      await connectCommand({
        positionals: [],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          platform: 'android',
        },
        client: createTestClient(),
      }),
    /connect requires tenant in remote config or via --tenant <id>/,
  );

  await assert.rejects(
    async () =>
      await connectCommand({
        positionals: [],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          tenant: 'acme',
          platform: 'android',
        },
        client: createTestClient(),
      }),
    /connect requires runId in remote config or via --run-id <id>/,
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization allocates lease and prepares Metro for open', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-open-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    },
  });
  let observedBridgeScope: { tenantId: string; runId: string; leaseId: string } | undefined;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
      metroPublicBaseUrl: 'https://sandbox.example.test',
      metroProxyBaseUrl: 'https://proxy.example.test',
    },
    client: createTestClient({
      allocate: async (request) => ({
        leaseId: 'lease-new',
        tenantId: request.tenant,
        runId: request.runId,
        backend: request.leaseBackend ?? 'android-instance',
      }),
      prepare: async (options) => {
        observedBridgeScope = options.bridgeScope;
        return metroPrepareResult({
          androidRuntime: { platform: 'android', bundleUrl: 'https://bundle.example.test' },
        });
      },
    }),
  });

  assert.equal(materialized.flags.leaseId, 'lease-new');
  assert.equal(materialized.flags.leaseBackend, 'android-instance');
  assert.deepEqual(materialized.runtime, {
    platform: 'android',
    bundleUrl: 'https://bundle.example.test',
  });
  assert.deepEqual(observedBridgeScope, {
    tenantId: 'acme',
    runId: 'run-123',
    leaseId: 'lease-new',
  });
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-android' })?.leaseId,
    'lease-new',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// fallow-ignore-next-line complexity
test('proxy open resolves device key before allocating lease', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-open-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
    },
  });
  const allocate = recordedLeaseAllocate({ leaseId: 'abc123abc123abc1', backend: 'ios-instance' });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'proxy',
      runId: 'proxy-client-1',
      session: 'adc-proxy',
      platform: 'ios',
    },
    client: createTestClient({
      listDevices: async () => [
        {
          platform: 'ios',
          target: 'mobile',
          kind: 'simulator',
          id: 'SIM-001',
          name: 'iPhone 16',
          booted: true,
          identifiers: { udid: 'SIM-001' },
          ios: { udid: 'SIM-001' },
        },
      ],
      allocate: allocate.stub,
    }),
  });

  assert.equal(allocate.request?.leaseProvider, 'proxy');
  assert.equal(allocate.request?.clientId, 'client-1');
  assert.equal(allocate.request?.deviceKey, 'ios:mobile:SIM-001');
  assert.equal(allocate.request?.ttlMs, PROXY_REMOTE_LEASE_TTL_MS);
  assert.equal(allocate.request?.leaseBackend, 'ios-instance');
  assert.equal(materialized.flags.leaseId, 'abc123abc123abc1');
  assert.equal(materialized.flags.udid, 'SIM-001');
  assert.equal(materialized.connection?.deviceKey, 'ios:mobile:SIM-001');
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, 'abc123abc123abc1');
  assert.equal(state?.deviceKey, 'ios:mobile:SIM-001');
  assert.equal(state?.leaseProvider, 'proxy');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('proxy install allocates a device lease before dispatch', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-install-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
    },
  });
  const allocate = recordedLeaseAllocate({
    leaseId: 'android-lease-1',
    backend: 'android-instance',
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'install',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'proxy',
      runId: 'proxy-client-1',
      session: 'adc-proxy',
      platform: 'android',
    },
    client: createTestClient({ allocate: allocate.stub }),
  });

  assert.equal(allocate.request?.leaseProvider, 'proxy');
  assert.equal(allocate.request?.clientId, 'client-1');
  assert.equal(allocate.request?.deviceKey, 'android:mobile:emulator-5554');
  assert.equal(allocate.request?.ttlMs, PROXY_REMOTE_LEASE_TTL_MS);
  assert.equal(allocate.request?.leaseBackend, 'android-instance');
  assert.equal(materialized.flags.leaseId, 'android-lease-1');
  assert.equal(materialized.flags.serial, 'emulator-5554');
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, 'android-lease-1');
  assert.equal(state?.deviceKey, 'android:mobile:emulator-5554');
  assert.equal(state?.leaseProvider, 'proxy');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('artifacts command reuses the stored cloud lease without allocating', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-cloud-artifacts-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-cloud',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'cloud-lease-1',
      leaseBackend: 'ios-instance',
      leaseProvider: 'aws-device-farm',
      platform: 'ios',
    },
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'artifacts',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-cloud',
    },
    client: createTestClient({
      allocate: unexpectedCommandCall,
      heartbeat: unexpectedCommandCall,
    }),
  });

  assert.equal(materialized.flags.leaseId, 'cloud-lease-1');
  assert.equal(materialized.connection?.leaseProvider, 'aws-device-farm');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('cloud webdriver connection allocates and heartbeats with extended lease TTL', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-cloud-ttl-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-cloud',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseProvider: 'aws-device-farm',
      platform: 'ios',
    },
  });
  const baseFlags = {
    json: true,
    help: false,
    version: false,
    stateDir,
    remoteConfig: remoteConfigPath,
    tenant: 'acme',
    runId: 'run-123',
    session: 'adc-cloud',
    platform: 'ios',
  } as const;
  let allocateRequest: Parameters<AgentDeviceClient['leases']['allocate']>[0] | undefined;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'screenshot',
    flags: { ...baseFlags },
    client: createTestClient({
      allocate: async (request) => {
        allocateRequest = request;
        return {
          leaseId: 'cloud-lease-1',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'ios-instance',
          leaseProvider: request.leaseProvider,
        };
      },
    }),
  });

  assert.equal(allocateRequest?.leaseProvider, 'aws-device-farm');
  assert.equal(allocateRequest?.ttlMs, CLOUD_WEBDRIVER_REMOTE_LEASE_TTL_MS);
  assert.equal(materialized.flags.leaseId, 'cloud-lease-1');

  let heartbeatRequest: Parameters<AgentDeviceClient['leases']['heartbeat']>[0] | undefined;
  await materializeRemoteConnectionForCommand({
    command: 'screenshot',
    flags: { ...baseFlags },
    client: createTestClient({
      heartbeat: async (request) => {
        heartbeatRequest = request;
        return {
          leaseId: request.leaseId,
          tenantId: request.tenant ?? 'acme',
          runId: request.runId ?? 'run-123',
          backend: request.leaseBackend ?? 'ios-instance',
          leaseProvider: request.leaseProvider,
        };
      },
    }),
  });

  assert.equal(heartbeatRequest?.leaseId, 'cloud-lease-1');
  assert.equal(heartbeatRequest?.ttlMs, CLOUD_WEBDRIVER_REMOTE_LEASE_TTL_MS);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('proxy commands without active device lease fail before allocation', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-proxy-closed-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      leaseBackend: 'ios-instance',
    },
  });

  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        command: 'snapshot',
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          tenant: 'proxy',
          runId: 'proxy-client-1',
          session: 'adc-proxy',
          platform: 'ios',
        },
        client: createTestClient({
          allocate: async () => {
            throw new Error('snapshot should not allocate without proxy device lease');
          },
        }),
      }),
    /No active proxy device lease for this session; run open first/,
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('direct remote-config materialization creates state and prepares Metro for open', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-direct-remote-open-',
  );
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'direct-android',
      platform: 'android',
      metroPublicBaseUrl: 'https://sandbox.example.test',
      metroProxyBaseUrl: 'https://proxy.example.test',
    }),
  );
  let observedBridgeScope: { tenantId: string; runId: string; leaseId: string } | undefined;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'direct-android',
      platform: 'android',
    },
    client: createTestClient({
      allocate: async (request) => ({
        leaseId: 'lease-direct',
        tenantId: request.tenant,
        runId: request.runId,
        backend: request.leaseBackend ?? 'android-instance',
      }),
      prepare: async (options) => {
        observedBridgeScope = options.bridgeScope;
        return metroPrepareResult({
          androidRuntime: { platform: 'android', bundleUrl: 'https://bundle.example.test' },
        });
      },
    }),
  });

  assert.equal(materialized.flags.leaseId, 'lease-direct');
  assert.deepEqual(materialized.runtime, {
    platform: 'android',
    bundleUrl: 'https://bundle.example.test',
  });
  assert.deepEqual(observedBridgeScope, {
    tenantId: 'acme',
    runId: 'run-123',
    leaseId: 'lease-direct',
  });
  assert.deepEqual(readRemoteConnectionState({ stateDir, session: 'direct-android' })?.runtime, {
    platform: 'android',
    bundleUrl: 'https://bundle.example.test',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization prepares Metro for batch when a step opens an app', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-batch-open-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    },
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'batch',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
      metroPublicBaseUrl: 'https://sandbox.example.test',
      metroProxyBaseUrl: 'https://proxy.example.test',
    },
    batchSteps: [{ command: 'open', input: { app: 'com.example.demo' } }],
    client: createTestClient(),
  });

  assert.equal(materialized.flags.leaseId, 'lease-1');
  assert.deepEqual(materialized.runtime, {
    platform: 'android',
    bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android',
  });
  assert.deepEqual(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runtime, {
    platform: 'android',
    bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization re-prepares runtime when explicit Metro overrides are provided', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-runtime-override-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-existing',
      leaseBackend: 'android-instance',
      platform: 'android',
      runtime: {
        platform: 'android',
        bundleUrl: 'https://old-bundle.example.test',
      },
      metro: {
        projectRoot: '/tmp/project-old',
        profileKey: remoteConfigPath,
        consumerKey: 'adc-android',
      },
    },
  });
  let prepareRequest: Parameters<AgentDeviceClient['metro']['prepare']>[0] | undefined;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
      metroProjectRoot: '/tmp/project-new',
      metroKind: 'repack',
      metroPublicBaseUrl: 'https://sandbox.example.test',
      metroProxyBaseUrl: 'https://proxy.example.test',
      launchUrl: 'myapp://open',
    },
    client: createTestClient({
      prepare: async (options) => {
        prepareRequest = options;
        return metroPrepareResult({
          projectRoot: '/tmp/project-new',
          kind: 'repack',
          reused: false,
          logPath: '/tmp/project-new/.agent-device/metro.log',
          androidRuntime: {
            platform: 'android',
            bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android&dev=true',
          },
        });
      },
    }),
    forceRuntimePrepare: true,
  });

  assert.equal(prepareRequest?.projectRoot, '/tmp/project-new');
  assert.equal(prepareRequest?.kind, 'repack');
  assert.equal(prepareRequest?.publicBaseUrl, 'https://sandbox.example.test');
  assert.equal(prepareRequest?.proxyBaseUrl, 'https://proxy.example.test');
  assert.equal(prepareRequest?.launchUrl, 'myapp://open');
  assert.deepEqual(materialized.runtime, {
    platform: 'android',
    bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android&dev=true',
  });
  assert.deepEqual(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runtime, {
    platform: 'android',
    bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android&dev=true',
  });
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project-old',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('cdp remote materialization prepares Metro runtime for bridge target discovery', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-agent-cdp-runtime-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  let prepareRequest: Parameters<AgentDeviceClient['metro']['prepare']>[0] | undefined;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'cdp',
    positionals: ['target', 'list'],
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
      leaseBackend: 'android-instance',
      metroProjectRoot: '/tmp/project',
      metroProxyBaseUrl: 'https://proxy.example.test',
      metroPublicBaseUrl: 'https://sandbox.example.test',
    },
    client: createTestClient({
      prepare: async (options) => {
        prepareRequest = options;
        return metroPrepareResult({
          androidRuntime: {
            platform: 'android',
            bundleUrl:
              'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
          },
        });
      },
    }),
  });

  assert.equal(prepareRequest?.proxyBaseUrl, 'https://proxy.example.test');
  assert.deepEqual(prepareRequest?.bridgeScope, {
    tenantId: 'acme',
    runId: 'run-123',
    leaseId: 'lease-1',
  });
  assert.deepEqual(materialized.runtime, {
    platform: 'android',
    bundleUrl:
      'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
  });
  assert.deepEqual(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.metro, {
    projectRoot: '/tmp/project',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('cdp remote materialization skips Metro runtime for non-target commands', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-agent-cdp-memory-',
  );
  fs.writeFileSync(path.join(tempRoot, 'remote.json'), JSON.stringify({}));
  let prepared = false;

  try {
    const materialized = await materializeRemoteConnectionForCommand({
      command: 'cdp',
      positionals: ['memory', 'usage', 'sample'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        tenant: 'acme',
        runId: 'run-123',
        session: 'adc-android',
        platform: 'android',
        leaseBackend: 'android-instance',
        metroProjectRoot: '/tmp/project',
        metroProxyBaseUrl: 'https://proxy.example.test',
        metroPublicBaseUrl: 'https://sandbox.example.test',
      },
      client: createTestClient({
        prepare: async () => {
          prepared = true;
          throw new Error('prepare should not be called');
        },
      }),
    });

    assert.equal(prepared, false);
    assert.equal(materialized.runtime, undefined);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cdp remote materialization skips Metro runtime without public CDP url', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-agent-cdp-no-public-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  let prepared = false;

  try {
    const materialized = await materializeRemoteConnectionForCommand({
      command: 'cdp',
      positionals: ['target', 'list'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        tenant: 'acme',
        runId: 'run-123',
        session: 'adc-android',
        platform: 'android',
        leaseBackend: 'android-instance',
        metroProjectRoot: '/tmp/project',
        metroProxyBaseUrl: 'https://proxy.example.test',
      },
      client: createTestClient({
        prepare: async () => {
          prepared = true;
          throw new Error('prepare should not be called');
        },
      }),
    });

    assert.equal(prepared, false);
    assert.equal(materialized.runtime, undefined);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('deferred materialization heartbeats an existing lease before dispatch', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-heartbeat-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-existing',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  });
  let heartbeatCount = 0;
  let allocateCount = 0;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'apps',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
    },
    client: createTestClient({
      heartbeat: async (request) => {
        heartbeatCount += 1;
        return {
          leaseId: request.leaseId,
          tenantId: request.tenant ?? 'acme',
          runId: request.runId ?? 'run-123',
          backend: request.leaseBackend ?? 'android-instance',
        };
      },
      allocate: async (request) => {
        allocateCount += 1;
        return {
          leaseId: 'lease-new',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'android-instance',
        };
      },
    }),
  });

  assert.equal(heartbeatCount, 1);
  assert.equal(allocateCount, 0);
  assert.equal(materialized.flags.leaseId, 'lease-existing');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-android' })?.leaseId,
    'lease-existing',
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization allocates pending lease for devices', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-devices-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    },
  });
  let allocateCount = 0;

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'devices',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
    },
    client: createTestClient({
      allocate: async (request) => {
        allocateCount += 1;
        return {
          leaseId: 'lease-devices',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'android-instance',
        };
      },
    }),
  });

  assert.equal(allocateCount, 1);
  assert.equal(materialized.flags.leaseId, 'lease-devices');
  assert.equal(materialized.flags.leaseBackend, 'android-instance');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-android' })?.leaseId,
    'lease-devices',
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred provider materialization forwards provider profile fields to lease allocation', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-provider-lease-flags-');
  const remoteConfigPath = path.join(tempRoot, 'browserstack.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      tenant: 'browserstack',
      runId: 'browserstack-run',
      leaseProvider: 'browserstack',
      leaseBackend: 'android-instance',
      platform: 'android',
      device: 'Google Pixel 8',
      providerOsVersion: '14.0',
      providerApp: '/tmp/WikipediaSample.apk',
      providerProject: 'agent-device',
      providerBuild: 'live-smoke',
    }),
  );
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-browserstack',
      remoteConfigPath,
      tenant: 'browserstack',
      runId: 'browserstack-run',
      leaseBackend: 'android-instance',
      leaseProvider: 'browserstack',
      platform: 'android',
    },
  });
  const allocate = recordedLeaseAllocate({
    leaseId: 'lease-browserstack',
    backend: 'android-instance',
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      tenant: 'browserstack',
      runId: 'browserstack-run',
      session: 'adc-browserstack',
      leaseBackend: 'android-instance',
      platform: 'android',
      device: 'Google Pixel 8',
      providerOsVersion: '14.0',
      providerApp: '/tmp/WikipediaSample.apk',
      providerProject: 'agent-device',
      providerBuild: 'live-smoke',
    },
    client: createTestClient({ allocate: allocate.stub }),
  });

  assert.equal(materialized.flags.leaseId, 'lease-browserstack');
  assert.equal(allocate.request?.platform, 'android');
  assert.equal(allocate.request?.device, 'Google Pixel 8');
  assert.equal(allocate.request?.providerApp, '/tmp/WikipediaSample.apk');
  assert.equal(allocate.request?.providerOsVersion, '14.0');
  assert.equal(allocate.request?.providerProject, 'agent-device');
  assert.equal(allocate.request?.providerBuild, 'live-smoke');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization reallocates when the persisted lease is inactive', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-stale-lease-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-existing',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'apps',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
      platform: 'android',
    },
    client: createTestClient({
      heartbeat: async () => {
        throw new AppError('UNAUTHORIZED', 'Lease is not active', {
          reason: 'LEASE_NOT_FOUND',
        });
      },
      allocate: async (request) => ({
        leaseId: 'lease-new',
        tenantId: request.tenant,
        runId: request.runId,
        backend: request.leaseBackend ?? 'android-instance',
      }),
    }),
  });

  assert.equal(materialized.flags.leaseId, 'lease-new');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-android' })?.leaseId,
    'lease-new',
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization preserves auth failures from lease allocation', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-auth-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
    },
  });

  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        command: 'apps',
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          tenant: 'acme',
          runId: 'run-123',
          session: 'adc-android',
          platform: 'android',
        },
        client: createTestClient({
          allocate: async () => {
            throw new AppError('UNAUTHORIZED', 'Request rejected by auth hook.', {
              reason: 'AUTH_FAILED',
            });
          },
        }),
      }),
    /Request rejected by auth hook/,
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization does not require a lease backend for close', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-close-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
    },
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'close',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      daemonBaseUrl: 'https://daemon.example',
      tenant: 'acme',
      runId: 'run-123',
      session: 'adc-android',
    },
    client: createTestClient({
      allocate: async () => {
        throw new Error('close should not allocate a lease');
      },
      heartbeat: async () => {
        throw new Error('close should not heartbeat a lease');
      },
    }),
  });

  assert.equal(materialized.flags.leaseId, undefined);
  assert.equal(materialized.flags.leaseBackend, undefined);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization stops the new Metro companion if state persistence fails', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-write-fail-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  const release = recordedLeaseRelease();
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: remoteConfigPath,
        consumerKey: 'adc-android',
      },
    },
  });

  const originalRenameSync = fs.renameSync.bind(fs);
  const writeFailure = new Error('state write failed');
  vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (String(newPath).endsWith(path.join('remote-connections', 'adc-android.json'))) {
      throw writeFailure;
    }
    return originalRenameSync(oldPath, newPath);
  });

  await assert.rejects(
    async () =>
      await materializeRemoteConnectionForCommand({
        command: 'open',
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          tenant: 'acme',
          runId: 'run-123',
          session: 'adc-android',
          platform: 'android',
          metroPublicBaseUrl: 'https://sandbox.example.test',
          metroProxyBaseUrl: 'https://proxy.example.test',
        },
        client: createTestClient({ release: release.stub }),
      }),
    writeFailure,
  );

  assert.equal(vi.mocked(stopMetroCompanion).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });
  assert.equal(release.request?.leaseId, 'lease-1');
  assert.equal(release.request?.tenant, 'acme');
  assert.equal(release.request?.runId, 'run-123');
  assert.equal(release.request?.leaseBackend, 'android-instance');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect requires force when compatible scope changes platform', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-platform-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  });

  await assert.rejects(
    async () =>
      await connectCommand({
        positionals: [],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://daemon.example',
          tenant: 'acme',
          runId: 'run-123',
          session: 'adc',
          platform: 'ios',
          leaseBackend: 'android-instance',
        },
        client: createTestClient(),
      }),
    /A different remote connection is already active/,
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect requires force when the daemon endpoint changes', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-daemon-',
  );
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://old.example' }));
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc',
      remoteConfigPath,
      daemon: { baseUrl: 'https://old.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  });

  await assert.rejects(
    async () =>
      await connectCommand({
        positionals: [],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          remoteConfig: remoteConfigPath,
          daemonBaseUrl: 'https://new.example',
          tenant: 'acme',
          runId: 'run-123',
          session: 'adc',
          platform: 'android',
        },
        client: createTestClient(),
      }),
    /A different remote connection is already active/,
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force stops replaced Metro companion after state is updated', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-');
  // Recoverable from the previous connection's own profile (plan 007
  // rule 1) so the forced release authenticates against old.example with
  // its own credential, not the new connection's.
  const { oldRemoteConfigPath, newRemoteConfigPath } = writeReplacedProfiles(tempRoot, {
    previousToken: 'test-old-not-a-real-token',
  });
  seedPreviousConnection({
    stateDir,
    remoteConfigPath: oldRemoteConfigPath,
    overrides: {
      daemon: {
        baseUrl: 'https://old.example',
        transport: 'http',
      },
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: oldRemoteConfigPath,
        consumerKey: 'adc-android',
      },
    },
  });
  const release = recordedLeaseRelease();

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonAuthToken: 'test-new-not-a-real-token',
      }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/old-project',
    profileKey: oldRemoteConfigPath,
    consumerKey: 'adc-android',
  });
  assert.equal(release.request?.leaseId, 'lease-old');
  assert.equal(release.request?.daemonBaseUrl, 'https://old.example');
  assert.equal(release.request?.daemonTransport, 'http');
  assert.equal(release.request?.daemonAuthToken, 'test-old-not-a-real-token');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force without a session does not replace the active generated connection', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-active-');
  const { oldRemoteConfigPath, newRemoteConfigPath } = writeReplacedProfiles(tempRoot, {
    previousToken: 'test-old-not-a-real-token',
  });
  seedPreviousConnection({
    stateDir,
    remoteConfigPath: oldRemoteConfigPath,
    overrides: {
      session: 'adc-7f3a2c',
      daemon: {
        baseUrl: 'https://old.example',
        transport: 'http',
      },
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: oldRemoteConfigPath,
        consumerKey: 'adc-7f3a2c',
      },
    },
  });
  const release = recordedLeaseRelease();

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonAuthToken: 'test-new-not-a-real-token',
        session: undefined,
      }),
      client: createTestClient({ release: release.stub }),
    });
  });

  const activeState = readActiveConnectionState({ stateDir });
  const storedSessions = fs
    .readdirSync(path.join(stateDir, 'remote-connections'))
    .filter((entry) => entry.endsWith('.json') && entry !== '.active-session.json');

  assert.notEqual(activeState?.session, 'adc-7f3a2c');
  assert.equal(activeState?.runId, 'run-new');
  assert.equal(activeState?.remoteConfigPath, newRemoteConfigPath);
  assert.equal(release.request, undefined);
  assert.equal(vi.mocked(stopMetroCompanion).mock.calls.length, 0);
  assert.equal(storedSessions.length, 2);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'adc-7f3a2c' })?.remoteConfigPath,
    oldRemoteConfigPath,
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("connect --force releases the previous lease with the previous connection's own token, not the new one", async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-prev-token-');
  // Token A: belongs to the previous (old) connection's own profile.
  const { oldRemoteConfigPath, newRemoteConfigPath } = writeReplacedProfiles(tempRoot, {
    previousToken: 'test-old-not-a-real-token',
  });
  seedPreviousConnection({ stateDir, remoteConfigPath: oldRemoteConfigPath });
  const release = recordedLeaseRelease();

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({
        stateDir,
        remoteConfig: newRemoteConfigPath,
        // Token B: the new connection's credential; must never reach old.example.
        daemonAuthToken: 'test-new-not-a-real-token',
      }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request?.leaseId, 'lease-old');
  assert.equal(release.request?.daemonBaseUrl, 'https://old.example');
  assert.equal(release.request?.daemonAuthToken, 'test-old-not-a-real-token');
  assert.notEqual(release.request?.daemonAuthToken, 'test-new-not-a-real-token');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force skips releasing the previous lease when its token cannot be recovered and the endpoint differs', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-unreleasable-');
  // No daemonAuthToken in the previous connection's own profile: its
  // credential cannot be recovered, and the new endpoint differs.
  const { oldRemoteConfigPath, newRemoteConfigPath } = writeReplacedProfiles(tempRoot);
  seedPreviousConnection({ stateDir, remoteConfigPath: oldRemoteConfigPath });
  const release = recordedLeaseRelease();

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({
        json: false,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonAuthToken: 'test-new-not-a-real-token',
      }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /tenant acme, run run-old/);
  assert.match(stdout, /old\.example/);
  // Reconnect still succeeds despite the orphaned previous lease.
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force does not misclassify an env-sourced new token as the previous connection’s own credential', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-env-token-');
  // Neither config file declares daemonAuthToken; the only source of a token
  // anywhere is the environment, which is global and belongs to the *new*
  // connection, not provably to old.example.
  const { oldRemoteConfigPath, newRemoteConfigPath } = writeReplacedProfiles(tempRoot);
  // Token B, supplied through the environment — not via --daemon-auth-token —
  // which is precisely the gap a merged-profile read would miss.
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'test-env-not-a-real-token');
  seedPreviousConnection({ stateDir, remoteConfigPath: oldRemoteConfigPath });
  const release = recordedLeaseRelease();

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      // No daemonAuthToken flag: the ambient token above flows in purely
      // through the environment, matching production's resolution chain.
      flags: forceConnectFlags({ json: false, stateDir, remoteConfig: newRemoteConfigPath }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /tenant acme, run run-old/);
  assert.match(stdout, /old\.example/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force does not treat a re-pointed config path’s token as the previous endpoint’s own', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-repointed-path-');
  // ONE path, reused. The previous connection was made against old.example
  // through this file; the file is then edited in place to describe a
  // different endpoint with a different credential. Distinct old/new paths
  // cannot express this: the leak is that `remoteConfigPath` still resolves,
  // and still parses, while no longer describing the connection it is being
  // consulted about.
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      daemonAuthToken: 'test-old-not-a-real-token',
    }),
  );
  // Recorded while the file still described old.example — the fact that
  // makes the later edit detectable.
  seedPreviousConnection({ stateDir, remoteConfigPath });
  // The edit: same path, now endpoint B with token B.
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://new.example',
      daemonAuthToken: 'test-new-not-a-real-token',
    }),
  );
  const release = recordedLeaseRelease();

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({ json: false, stateDir, remoteConfig: remoteConfigPath }),
      client: createTestClient({ release: release.stub }),
    });
  });

  // No request at all — not merely a request carrying a different token.
  assert.equal(release.request, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /old\.example/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force does not trust an unchanged profile token for a CLI-overridden previous endpoint', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-force-cli-override-',
  );
  // The profile has always described endpoint B. The previous connection used
  // explicit CLI credentials for endpoint A, so the unchanged file hash proves
  // only which file was loaded — not that its token authenticated endpoint A.
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://new.example',
      daemonAuthToken: 'test-new-not-a-real-token',
    }),
  );
  // Effective previous endpoint A came from --daemon-base-url, overriding
  // the profile's endpoint B when this state was recorded.
  seedPreviousConnection({ stateDir, remoteConfigPath });
  const release = recordedLeaseRelease();

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({
        json: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonAuthToken: 'test-new-not-a-real-token',
      }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /old\.example/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force still releases with a rotated credential when the config keeps the same endpoint', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connect-force-rotated-token-');
  const { oldRemoteConfigPath, newRemoteConfigPath } = writeReplacedProfiles(tempRoot, {
    previousToken: 'test-old-not-a-real-token',
  });
  seedPreviousConnection({ stateDir, remoteConfigPath: oldRemoteConfigPath });
  // The file changed — so the hash no longer matches — but it still describes
  // old.example, so the rotated token is still that endpoint's own credential
  // and must still release its lease. This is the case an edit-detecting rule
  // must not break: refusing here would orphan leases on every key rotation.
  fs.writeFileSync(
    oldRemoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      daemonAuthToken: 'test-rotated-not-a-real-token',
    }),
  );
  const release = recordedLeaseRelease();

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({ stateDir, remoteConfig: newRemoteConfigPath }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request?.leaseId, 'lease-old');
  assert.equal(release.request?.daemonBaseUrl, 'https://old.example');
  assert.equal(release.request?.daemonAuthToken, 'test-rotated-not-a-real-token');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force reuses the ambient token to release the previous lease when the endpoint is unchanged', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connect-force-same-endpoint-',
  );
  // No daemonAuthToken on the profile itself: the ambient flag is the only
  // source, matching an ordinary same-profile --force reconnect.
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  seedPreviousConnection({
    stateDir,
    remoteConfigPath,
    overrides: { daemon: { baseUrl: 'https://daemon.example' } },
  });
  const release = recordedLeaseRelease();

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: forceConnectFlags({
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        daemonAuthToken: 'test-ambient-not-a-real-token',
      }),
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request?.leaseId, 'lease-old');
  assert.equal(release.request?.daemonBaseUrl, 'https://daemon.example');
  assert.equal(release.request?.daemonAuthToken, 'test-ambient-not-a-real-token');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect tolerates prior close and removes local connection state', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace('agent-device-disconnect-');
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  fs.writeFileSync(remoteConfigPath, '{}');
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'adc-android.json'),
    JSON.stringify({
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      metro: {
        projectRoot: '/tmp/project',
        profileKey: remoteConfigPath,
        consumerKey: 'adc-android',
      },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  let handled = false;
  await captureStdout(async () => {
    handled = await disconnectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        session: 'adc-android',
        shutdown: true,
      },
      client: createTestClient({
        closeSession: async () => {
          throw new Error('already closed');
        },
        release: async () => ({ released: false }),
      }),
    });
  });

  assert.equal(handled, true);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' }), null);
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect after connect-only cleanup stays local when no session resources exist', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-disconnect-pending-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-pending',
      remoteConfigPath,
      tenant: 'limrun',
      runId: 'run-123',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
    },
  });
  let closeCalls = 0;

  await captureStdout(async () => {
    await disconnectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        stateDir,
      },
      client: createTestClient({
        closeSession: async () => {
          closeCalls += 1;
          throw new Error('disconnect must not contact a daemon');
        },
      }),
    });
  });

  assert.equal(closeCalls, 0);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-pending' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect without a session uses active connection state', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-disconnect-active-',
  );
  const closedSessions: Array<{ session: string | undefined; shutdown: boolean | undefined }> = [];
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
    },
  });

  await captureStdout(async () => {
    await disconnectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        shutdown: true,
      },
      client: createTestClient({
        closeSession: async (options) => {
          closedSessions.push({ session: options?.session, shutdown: options?.shutdown });
          return {
            session: options?.session ?? 'default',
            identifiers: { session: options?.session ?? 'default' },
          };
        },
      }),
    });
  });

  assert.deepEqual(closedSessions, [{ session: 'adc-android', shutdown: true }]);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect human output surfaces provider release warnings and artifact links', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-disconnect-provider-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-browserstack',
      remoteConfigPath,
      tenant: 'browserstack',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'browserstack',
    },
  });

  const output = await captureStdout(async () => {
    await disconnectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        stateDir,
        session: 'adc-browserstack',
      },
      client: createTestClient({
        closeSession: async () => ({
          session: 'adc-browserstack',
          identifiers: { session: 'adc-browserstack' },
          provider: {
            provider: 'browserstack',
            providerSessionId: 'wd-1',
            warnings: [
              {
                code: 'WEBDRIVER_SESSION_DELETE_FAILED',
                message: 'stale webdriver session',
              },
            ],
            cloudArtifacts: {
              provider: 'browserstack',
              providerSessionId: 'wd-1',
              status: 'ready',
              cloudArtifacts: [
                {
                  provider: 'browserstack',
                  providerSessionId: 'wd-1',
                  kind: 'video',
                  name: 'Session video',
                  url: 'https://provider.example/video.mp4',
                  availability: 'ready',
                },
              ],
            },
          },
        }),
      }),
    });
  });

  assert.match(output, /Disconnected remote session "adc-browserstack"\./);
  assert.match(
    output,
    /Provider release warning \(WEBDRIVER_SESSION_DELETE_FAILED\): stale webdriver session/,
  );
  assert.match(output, /Session video: https:\/\/provider\.example\/video\.mp4/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-browserstack' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect releases proxy lease with provider client and device metadata', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-disconnect-proxy-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-proxy',
      remoteConfigPath,
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseId: 'abc123abc123abc1',
      daemon: {
        baseUrl: 'http://proxy.example.test/agent-device',
      },
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'ios:mobile:SIM-001',
    },
  });
  const release = recordedLeaseRelease();

  await captureStdout(async () => {
    await disconnectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        shutdown: true,
        // Not persisted on connection state (ADR 0007): the caller supplies
        // it per-command via flag/env/CLI-session, mirroring how the CLI
        // dispatcher resolves it before invoking this handler.
        daemonAuthToken: 'test-not-a-real-token',
      },
      client: createTestClient({ release: release.stub }),
    });
  });

  assert.equal(release.request?.leaseProvider, 'proxy');
  assert.equal(release.request?.clientId, 'client-1');
  assert.equal(release.request?.deviceKey, 'ios:mobile:SIM-001');
  assert.equal(release.request?.leaseId, 'abc123abc123abc1');
  assert.equal(release.request?.leaseBackend, 'ios-instance');
  assert.equal(release.request?.daemonBaseUrl, 'http://proxy.example.test/agent-device');
  assert.equal(release.request?.daemonAuthToken, 'test-not-a-real-token');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection status reports missing state without daemon calls', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-connection-status-');
  let handled = false;
  await captureStdout(async () => {
    handled = await connectionCommand({
      positionals: ['status'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        session: 'adc-android',
      },
      client: createTestClient(),
    });
  });
  assert.equal(handled, true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection status reports active connection state', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connection-active-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
    },
  });

  const output = await captureStdout(async () => {
    await connectionCommand({
      positionals: ['status'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
      },
      client: createTestClient(),
    });
  });

  assert.equal(JSON.parse(output).data.session, 'adc-android');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection state filenames distinguish unsafe session names', () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connection-state-names-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  const baseState = {
    version: 1 as const,
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    tenant: 'acme',
    runId: 'run-123',
    leaseBackend: 'android-instance' as const,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeRemoteConnectionState({
    stateDir,
    state: { ...baseState, session: 'a/b', leaseId: 'lease-slash' },
  });
  writeRemoteConnectionState({
    stateDir,
    state: { ...baseState, session: 'a_b', leaseId: 'lease-underscore' },
  });

  assert.equal(readRemoteConnectionState({ stateDir, session: 'a/b' })?.leaseId, 'lease-slash');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'a_b' })?.leaseId,
    'lease-underscore',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
  let stdout = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }

  return stdout;
}
