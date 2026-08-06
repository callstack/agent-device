import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

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

const unexpectedCommandCall = async (): Promise<never> => {
  throw new Error('unexpected call');
};

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

function createThrowingMethodGroup<T extends object>(methods: Partial<T> = {}): T {
  return new Proxy(methods, {
    get: (target, property) => target[property as keyof T] ?? unexpectedCommandCall,
  }) as T;
}

function createTestClient(
  options: {
    allocate?: AgentDeviceClient['leases']['allocate'];
    heartbeat?: AgentDeviceClient['leases']['heartbeat'];
    release?: AgentDeviceClient['leases']['release'];
    prepare?: AgentDeviceClient['metro']['prepare'];
    closeSession?: AgentDeviceClient['sessions']['close'];
    listDevices?: AgentDeviceClient['devices']['list'];
  } = {},
): AgentDeviceClient {
  return {
    command: createThrowingMethodGroup<AgentDeviceClient['command']>(),
    devices: createThrowingMethodGroup<AgentDeviceClient['devices']>({
      list:
        options.listDevices ??
        (async () => [
          {
            platform: 'android',
            target: 'mobile',
            kind: 'emulator',
            id: 'emulator-5554',
            name: 'Android Emulator',
            booted: true,
            identifiers: { serial: 'emulator-5554' },
            android: { serial: 'emulator-5554' },
          },
        ]),
    }),
    sessions: createThrowingMethodGroup<AgentDeviceClient['sessions']>({
      close:
        options.closeSession ??
        (async () => ({
          session: 'adc-android',
          identifiers: { session: 'adc-android' },
        })),
    }),
    apps: createThrowingMethodGroup<AgentDeviceClient['apps']>(),
    materializations: createThrowingMethodGroup<AgentDeviceClient['materializations']>(),
    leases: createThrowingMethodGroup<AgentDeviceClient['leases']>({
      allocate:
        options.allocate ??
        (async (request) => ({
          leaseId: 'lease-1',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'android-instance',
        })),
      heartbeat:
        options.heartbeat ??
        (async (request) => ({
          leaseId: request.leaseId,
          tenantId: request.tenant ?? 'acme',
          runId: request.runId ?? 'run-123',
          backend: request.leaseBackend ?? 'android-instance',
        })),
      release: options.release ?? (async () => ({ released: true })),
    }),
    metro: createThrowingMethodGroup<AgentDeviceClient['metro']>({
      prepare:
        options.prepare ??
        (async () => ({
          projectRoot: '/tmp/project',
          kind: 'react-native',
          dependenciesInstalled: false,
          packageManager: null,
          started: false,
          reused: true,
          pid: 0,
          logPath: '/tmp/project/.agent-device/metro.log',
          statusUrl: 'http://127.0.0.1:8081/status',
          runtimeFilePath: null,
          iosRuntime: { platform: 'ios' },
          androidRuntime: {
            platform: 'android',
            bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android',
          },
          bridge: null,
        })),
    }),
    capture: createThrowingMethodGroup<AgentDeviceClient['capture']>(),
    interactions: createThrowingMethodGroup<AgentDeviceClient['interactions']>(),
    replay: createThrowingMethodGroup<AgentDeviceClient['replay']>(),
    batch: createThrowingMethodGroup<AgentDeviceClient['batch']>(),
    observability: createThrowingMethodGroup<AgentDeviceClient['observability']>(),
    debug: createThrowingMethodGroup<AgentDeviceClient['debug']>(),
    recording: createThrowingMethodGroup<AgentDeviceClient['recording']>(),
    settings: createThrowingMethodGroup<AgentDeviceClient['settings']>(),
  };
}

test('connect auto-generates a local session and writes minimal remote state', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-');
  const stateDir = path.join(tempRoot, '.state');

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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-shortcut-');
  const stateDir = path.join(tempRoot, '.state');

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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-sessions-');
  const stateDir = path.join(tempRoot, '.state');

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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-notice-');
  const stateDir = path.join(tempRoot, '.state');

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
  const tempRoot = mkdtempForTestSync('agent-device-generated-profile-');
  const configPath = writeGeneratedRemoteConfig({
    stateDir: path.join(tempRoot, '.state'),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-errors-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-metro-notice-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  assert.equal(readActiveConnectionState({ stateDir })?.runtime, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect without a session reuses the active generated connection', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-idempotent-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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

  assert.equal(secondState?.session, firstState?.session);
  assert.equal(storedSessions.length, 1);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect missing scope errors mention remote config or flags', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-scope-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-open-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
        return {
          projectRoot: '/tmp/project',
          kind: 'react-native',
          dependenciesInstalled: false,
          packageManager: null,
          started: false,
          reused: true,
          pid: 0,
          logPath: '/tmp/project/.agent-device/metro.log',
          statusUrl: 'http://127.0.0.1:8081/status',
          runtimeFilePath: null,
          iosRuntime: { platform: 'ios' },
          androidRuntime: { platform: 'android', bundleUrl: 'https://bundle.example.test' },
          bridge: null,
        };
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-open-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-proxy',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let allocateRequest: Parameters<AgentDeviceClient['leases']['allocate']>[0] | undefined;

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
      allocate: async (request) => {
        allocateRequest = request;
        return {
          leaseId: 'abc123abc123abc1',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'ios-instance',
          leaseProvider: request.leaseProvider,
          clientId: request.clientId,
          deviceKey: request.deviceKey,
        };
      },
    }),
  });

  assert.equal(allocateRequest?.leaseProvider, 'proxy');
  assert.equal(allocateRequest?.clientId, 'client-1');
  assert.equal(allocateRequest?.deviceKey, 'ios:mobile:SIM-001');
  assert.equal(allocateRequest?.ttlMs, PROXY_REMOTE_LEASE_TTL_MS);
  assert.equal(allocateRequest?.leaseBackend, 'ios-instance');
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-install-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-proxy',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let allocateRequest: Parameters<AgentDeviceClient['leases']['allocate']>[0] | undefined;

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
    client: createTestClient({
      allocate: async (request) => {
        allocateRequest = request;
        return {
          leaseId: 'android-lease-1',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'android-instance',
          leaseProvider: request.leaseProvider,
          clientId: request.clientId,
          deviceKey: request.deviceKey,
        };
      },
    }),
  });

  assert.equal(allocateRequest?.leaseProvider, 'proxy');
  assert.equal(allocateRequest?.clientId, 'client-1');
  assert.equal(allocateRequest?.deviceKey, 'android:mobile:emulator-5554');
  assert.equal(allocateRequest?.ttlMs, PROXY_REMOTE_LEASE_TTL_MS);
  assert.equal(allocateRequest?.leaseBackend, 'android-instance');
  assert.equal(materialized.flags.leaseId, 'android-lease-1');
  assert.equal(materialized.flags.serial, 'emulator-5554');
  const state = readRemoteConnectionState({ stateDir, session: 'adc-proxy' });
  assert.equal(state?.leaseId, 'android-lease-1');
  assert.equal(state?.deviceKey, 'android:mobile:emulator-5554');
  assert.equal(state?.leaseProvider, 'proxy');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('artifacts command reuses the stored cloud lease without allocating', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-artifacts-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-cloud',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'cloud-lease-1',
      leaseBackend: 'ios-instance',
      leaseProvider: 'aws-device-farm',
      platform: 'ios',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-ttl-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-cloud',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      leaseProvider: 'aws-device-farm',
      platform: 'ios',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-proxy-closed-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-proxy',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'proxy',
      runId: 'proxy-client-1',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      leaseBackend: 'ios-instance',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-direct-remote-open-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
        return {
          projectRoot: '/tmp/project',
          kind: 'react-native',
          dependenciesInstalled: false,
          packageManager: null,
          started: false,
          reused: true,
          pid: 0,
          logPath: '/tmp/project/.agent-device/metro.log',
          statusUrl: 'http://127.0.0.1:8081/status',
          runtimeFilePath: null,
          iosRuntime: { platform: 'ios' },
          androidRuntime: { platform: 'android', bundleUrl: 'https://bundle.example.test' },
          bridge: null,
        };
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-batch-open-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-runtime-override-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
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
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
        return {
          projectRoot: '/tmp/project-new',
          kind: 'repack',
          dependenciesInstalled: false,
          packageManager: null,
          started: false,
          reused: false,
          pid: 0,
          logPath: '/tmp/project-new/.agent-device/metro.log',
          statusUrl: 'http://127.0.0.1:8081/status',
          runtimeFilePath: null,
          iosRuntime: { platform: 'ios' },
          androidRuntime: {
            platform: 'android',
            bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android&dev=true',
          },
          bridge: null,
        };
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
  const tempRoot = mkdtempForTestSync('agent-device-agent-cdp-runtime-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
        return {
          projectRoot: '/tmp/project',
          kind: 'react-native',
          dependenciesInstalled: false,
          packageManager: null,
          started: false,
          reused: true,
          pid: 0,
          logPath: '/tmp/project/.agent-device/metro.log',
          statusUrl: 'http://127.0.0.1:8081/status',
          runtimeFilePath: null,
          iosRuntime: { platform: 'ios' },
          androidRuntime: {
            platform: 'android',
            bundleUrl:
              'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
          },
          bridge: null,
        };
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
  const tempRoot = mkdtempForTestSync('agent-device-agent-cdp-memory-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  const tempRoot = mkdtempForTestSync('agent-device-agent-cdp-no-public-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-heartbeat-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-existing',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-devices-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-provider-lease-flags-');
  const stateDir = path.join(tempRoot, '.state');
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
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-browserstack',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'browserstack',
      runId: 'browserstack-run',
      leaseBackend: 'android-instance',
      leaseProvider: 'browserstack',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let allocateRequest: Parameters<AgentDeviceClient['leases']['allocate']>[0] | undefined;

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
    client: createTestClient({
      allocate: async (request) => {
        allocateRequest = request;
        return {
          leaseId: 'lease-browserstack',
          tenantId: request.tenant,
          runId: request.runId,
          backend: request.leaseBackend ?? 'android-instance',
          leaseProvider: request.leaseProvider,
          clientId: request.clientId,
          deviceKey: request.deviceKey,
        };
      },
    }),
  });

  assert.equal(materialized.flags.leaseId, 'lease-browserstack');
  assert.equal(allocateRequest?.platform, 'android');
  assert.equal(allocateRequest?.device, 'Google Pixel 8');
  assert.equal(allocateRequest?.providerApp, '/tmp/WikipediaSample.apk');
  assert.equal(allocateRequest?.providerOsVersion, '14.0');
  assert.equal(allocateRequest?.providerProject, 'agent-device');
  assert.equal(allocateRequest?.providerBuild, 'live-smoke');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('deferred materialization reallocates when the persisted lease is inactive', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-stale-lease-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-existing',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-auth-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-close-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-write-fail-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example' },
      tenant: 'acme',
      runId: 'run-123',
      platform: 'android',
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: remoteConfigPath,
        consumerKey: 'adc-android',
      },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  const originalWriteFileSync = fs.writeFileSync.bind(fs);
  const writeFailure = new Error('state write failed');
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (String(file).endsWith(path.join('remote-connections', 'adc-android.json'))) {
      throw writeFailure;
    }
    return originalWriteFileSync(
      file as Parameters<typeof fs.writeFileSync>[0],
      data as Parameters<typeof fs.writeFileSync>[1],
      options as Parameters<typeof fs.writeFileSync>[2],
    );
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
        client: createTestClient({
          release: async (request) => {
            releaseRequest = request;
            return { released: true };
          },
        }),
      }),
    writeFailure,
  );

  assert.equal(vi.mocked(stopMetroCompanion).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });
  assert.equal(releaseRequest?.leaseId, 'lease-1');
  assert.equal(releaseRequest?.tenant, 'acme');
  assert.equal(releaseRequest?.runId, 'run-123');
  assert.equal(releaseRequest?.leaseBackend, 'android-instance');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect requires force when compatible scope changes platform', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-platform-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-daemon-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://old.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://old.example' },
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-');
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  fs.writeFileSync(
    oldRemoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      // Recoverable from the previous connection's own profile (plan 007
      // rule 1) so the forced release authenticates against old.example with
      // its own credential, not the new connection's.
      daemonAuthToken: 'test-old-not-a-real-token',
    }),
  );
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath: oldRemoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(oldRemoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: {
        baseUrl: 'https://old.example',
        transport: 'http',
      },
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: oldRemoteConfigPath,
        consumerKey: 'adc-android',
      },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        daemonAuthToken: 'test-new-not-a-real-token',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/old-project',
    profileKey: oldRemoteConfigPath,
    consumerKey: 'adc-android',
  });
  assert.equal(releaseRequest?.leaseId, 'lease-old');
  assert.equal(releaseRequest?.daemonBaseUrl, 'https://old.example');
  assert.equal(releaseRequest?.daemonTransport, 'http');
  assert.equal(releaseRequest?.daemonAuthToken, 'test-old-not-a-real-token');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force without a session replaces the active generated connection', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-active-');
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  fs.writeFileSync(
    oldRemoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      daemonAuthToken: 'test-old-not-a-real-token',
    }),
  );
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-7f3a2c',
      remoteConfigPath: oldRemoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(oldRemoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: {
        baseUrl: 'https://old.example',
        transport: 'http',
      },
      metro: {
        projectRoot: '/tmp/old-project',
        profileKey: oldRemoteConfigPath,
        consumerKey: 'adc-7f3a2c',
      },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        daemonAuthToken: 'test-new-not-a-real-token',
        tenant: 'acme',
        runId: 'run-new',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  const activeState = readActiveConnectionState({ stateDir });
  const storedSessions = fs
    .readdirSync(path.join(stateDir, 'remote-connections'))
    .filter((entry) => entry.endsWith('.json') && entry !== '.active-session.json');

  assert.equal(activeState?.session, 'adc-7f3a2c');
  assert.equal(activeState?.runId, 'run-new');
  assert.equal(activeState?.remoteConfigPath, newRemoteConfigPath);
  assert.equal(releaseRequest?.leaseId, 'lease-old');
  assert.equal(releaseRequest?.daemonAuthToken, 'test-old-not-a-real-token');
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/old-project',
    profileKey: oldRemoteConfigPath,
    consumerKey: 'adc-7f3a2c',
  });
  assert.equal(storedSessions.length, 1);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("connect --force releases the previous lease with the previous connection's own token, not the new one", async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-prev-token-');
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  fs.writeFileSync(
    oldRemoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      // Token A: belongs to the previous (old) connection's own profile.
      daemonAuthToken: 'test-old-not-a-real-token',
    }),
  );
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath: oldRemoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(oldRemoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://old.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        // Token B: the new connection's credential; must never reach old.example.
        daemonAuthToken: 'test-new-not-a-real-token',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseRequest?.leaseId, 'lease-old');
  assert.equal(releaseRequest?.daemonBaseUrl, 'https://old.example');
  assert.equal(releaseRequest?.daemonAuthToken, 'test-old-not-a-real-token');
  assert.notEqual(releaseRequest?.daemonAuthToken, 'test-new-not-a-real-token');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force skips releasing the previous lease when its token cannot be recovered and the endpoint differs', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-unreleasable-');
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  // No daemonAuthToken in the previous connection's own profile: its
  // credential cannot be recovered, and the new endpoint differs.
  fs.writeFileSync(oldRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://old.example' }));
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath: oldRemoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(oldRemoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://old.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseCalled = false;

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        daemonAuthToken: 'test-new-not-a-real-token',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async () => {
          releaseCalled = true;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseCalled, false);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /tenant acme, run run-old/);
  assert.match(stdout, /old\.example/);
  // Reconnect still succeeds despite the orphaned previous lease.
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force does not misclassify an env-sourced new token as the previous connection’s own credential', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-env-token-');
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  // Neither config file declares daemonAuthToken; the only source of a token
  // anywhere is the environment, which is global and belongs to the *new*
  // connection, not provably to old.example.
  fs.writeFileSync(oldRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://old.example' }));
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  // Token B, supplied through the environment — not via --daemon-auth-token —
  // which is precisely the gap a merged-profile read would miss.
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'test-env-not-a-real-token');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath: oldRemoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(oldRemoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://old.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        // No daemonAuthToken flag: the ambient token below flows in purely
        // through the environment, matching production's resolution chain.
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseRequest, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /tenant acme, run run-old/);
  assert.match(stdout, /old\.example/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force does not treat a re-pointed config path’s token as the previous endpoint’s own', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-repointed-path-');
  const stateDir = path.join(tempRoot, '.state');
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
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      // Recorded while the file still described old.example — the fact that
      // makes the later edit detectable.
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://old.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  // The edit: same path, now endpoint B with token B.
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://new.example',
      daemonAuthToken: 'test-new-not-a-real-token',
    }),
  );
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  // No request at all — not merely a request carrying a different token.
  assert.equal(releaseRequest, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /old\.example/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force does not trust an unchanged profile token for a CLI-overridden previous endpoint', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-cli-override-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      // Effective previous endpoint A came from --daemon-base-url, overriding
      // the profile's endpoint B when this state was recorded.
      daemon: { baseUrl: 'https://old.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  const stdout = await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        daemonAuthToken: 'test-new-not-a-real-token',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseRequest, undefined);
  assert.match(stdout, /Could not release the previous lease lease-old/);
  assert.match(stdout, /old\.example/);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force still releases with a rotated credential when the config keeps the same endpoint', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-rotated-token-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      daemonAuthToken: 'test-old-not-a-real-token',
    }),
  );
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://old.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  // The file changed — so the hash no longer matches — but it still describes
  // old.example, so the rotated token is still that endpoint's own credential
  // and must still release its lease. This is the case an edit-detecting rule
  // must not break: refusing here would orphan leases on every key rotation.
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      daemonAuthToken: 'test-rotated-not-a-real-token',
    }),
  );
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: newRemoteConfigPath,
        daemonBaseUrl: 'https://new.example',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseRequest?.leaseId, 'lease-old');
  assert.equal(releaseRequest?.daemonBaseUrl, 'https://old.example');
  assert.equal(releaseRequest?.daemonAuthToken, 'test-rotated-not-a-real-token');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force reuses the ambient token to release the previous lease when the endpoint is unchanged', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-force-same-endpoint-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  // No daemonAuthToken on the profile itself: the ambient flag is the only
  // source, matching an ordinary same-profile --force reconnect.
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://daemon.example' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://daemon.example' },
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

  await captureStdout(async () => {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        force: true,
        stateDir,
        remoteConfig: remoteConfigPath,
        daemonBaseUrl: 'https://daemon.example',
        daemonAuthToken: 'test-ambient-not-a-real-token',
        tenant: 'acme',
        runId: 'run-new',
        session: 'adc-android',
        platform: 'android',
      },
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseRequest?.leaseId, 'lease-old');
  assert.equal(releaseRequest?.daemonBaseUrl, 'https://daemon.example');
  assert.equal(releaseRequest?.daemonAuthToken, 'test-ambient-not-a-real-token');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect tolerates prior close and removes local connection state', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-disconnect-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
  const tempRoot = mkdtempForTestSync('agent-device-disconnect-pending-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-pending',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'limrun',
      runId: 'run-123',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-disconnect-active-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  const closedSessions: Array<{ session: string | undefined; shutdown: boolean | undefined }> = [];
  fs.writeFileSync(remoteConfigPath, '{}');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-disconnect-provider-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-browserstack',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'browserstack',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'browserstack',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-disconnect-proxy-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-proxy',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
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
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  let releaseRequest: Parameters<AgentDeviceClient['leases']['release']>[0] | undefined;

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
      client: createTestClient({
        release: async (request) => {
          releaseRequest = request;
          return { released: true };
        },
      }),
    });
  });

  assert.equal(releaseRequest?.leaseProvider, 'proxy');
  assert.equal(releaseRequest?.clientId, 'client-1');
  assert.equal(releaseRequest?.deviceKey, 'ios:mobile:SIM-001');
  assert.equal(releaseRequest?.leaseId, 'abc123abc123abc1');
  assert.equal(releaseRequest?.leaseBackend, 'ios-instance');
  assert.equal(releaseRequest?.daemonBaseUrl, 'http://proxy.example.test/agent-device');
  assert.equal(releaseRequest?.daemonAuthToken, 'test-not-a-real-token');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-proxy' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection status reports missing state without daemon calls', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connection-status-');
  let handled = false;
  await captureStdout(async () => {
    handled = await connectionCommand({
      positionals: ['status'],
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir: path.join(tempRoot, '.state'),
        session: 'adc-android',
      },
      client: createTestClient(),
    });
  });
  assert.equal(handled, true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection status reports active connection state', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connection-active-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  const tempRoot = mkdtempForTestSync('agent-device-connection-state-names-');
  const stateDir = path.join(tempRoot, '.state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
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
