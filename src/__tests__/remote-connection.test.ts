import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../client-metro-companion.ts', () => ({
  stopMetroCompanion: vi.fn(),
}));

vi.mock('../client-react-devtools-companion.ts', () => ({
  stopReactDevtoolsCompanion: vi.fn(),
}));

import {
  connectCommand,
  connectionCommand,
  disconnectCommand,
} from '../cli/commands/connection.ts';
import {
  hasDeferredMetroConfig,
  materializeRemoteConnectionForCommand,
} from '../cli/commands/connection-runtime.ts';
import { stopMetroCompanion } from '../client-metro-companion.ts';
import { AppError } from '../utils/errors.ts';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '../remote-connection-state.ts';
import type { AgentDeviceClient } from '../client.ts';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
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
      metroKind: 'expo',
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
  } = {},
): AgentDeviceClient {
  return {
    command: createThrowingMethodGroup<AgentDeviceClient['command']>(),
    devices: createThrowingMethodGroup<AgentDeviceClient['devices']>(),
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-'));
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

test('connect reports deferred Metro runtime preparation when remote config has Metro settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-metro-notice-'));
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

  assert.match(stdout, /Lease allocation is pending/);
  assert.match(stdout, /open, snapshot, or devices/);
  assert.match(stdout, /Metro runtime is not prepared yet/);
  assert.match(stdout, /metro prepare --remote-config/);
  assert.equal(readActiveConnectionState({ stateDir })?.runtime, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect without a session reuses the active generated connection', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-idempotent-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-scope-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-open-'));
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

test('direct remote-config materialization creates state and prepares Metro for open', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-direct-remote-open-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-batch-open-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-runtime-override-'));
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
      metroKind: 'expo',
      metroPublicBaseUrl: 'https://sandbox.example.test',
      metroProxyBaseUrl: 'https://proxy.example.test',
      launchUrl: 'myapp://open',
    },
    client: createTestClient({
      prepare: async (options) => {
        prepareRequest = options;
        return {
          projectRoot: '/tmp/project-new',
          kind: 'expo',
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
  assert.equal(prepareRequest?.kind, 'expo');
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-agent-cdp-runtime-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-agent-cdp-memory-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-agent-cdp-no-public-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-heartbeat-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-devices-'));
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

test('deferred materialization reallocates when the persisted lease is inactive', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-stale-lease-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-auth-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-close-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-write-fail-'));
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
        client: createTestClient(),
      }),
    writeFailure,
  );

  assert.equal(vi.mocked(stopMetroCompanion).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    profileKey: remoteConfigPath,
    consumerKey: 'adc-android',
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect requires force when compatible scope changes platform', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-platform-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-daemon-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-force-'));
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
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
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' })?.runId, 'run-new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connect --force without a session replaces the active generated connection', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-force-active-'));
  const stateDir = path.join(tempRoot, '.state');
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  fs.writeFileSync(oldRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://old.example' }));
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
  assert.deepEqual(vi.mocked(stopMetroCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/old-project',
    profileKey: oldRemoteConfigPath,
    consumerKey: 'adc-7f3a2c',
  });
  assert.equal(storedSessions.length, 1);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect tolerates prior close and removes local connection state', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-disconnect-'));
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

test('disconnect without a session uses active connection state', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-disconnect-active-'));
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
      client: createTestClient(),
    });
  });

  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-android' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('connection status reports missing state without daemon calls', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connection-status-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connection-active-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connection-state-names-'));
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
