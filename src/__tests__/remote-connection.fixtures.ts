import fs from 'node:fs';
import path from 'node:path';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

export const unexpectedCommandCall = async (): Promise<never> => {
  throw new Error('unexpected call');
};

function createThrowingMethodGroup<T extends object>(methods: Partial<T> = {}): T {
  return new Proxy(methods, {
    get: (target, property) => target[property as keyof T] ?? unexpectedCommandCall,
  }) as T;
}

export type MetroPrepareResult = Awaited<ReturnType<AgentDeviceClient['metro']['prepare']>>;

/** A reused React Native Metro whose Android bundle is served from the sandbox host. */
export function metroPrepareResult(
  overrides: Partial<MetroPrepareResult> = {},
): MetroPrepareResult {
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
      bundleUrl: 'https://sandbox.example.test/index.bundle?platform=android',
    },
    bridge: null,
    ...overrides,
  };
}

/**
 * A client whose device inventory is one booted Android emulator and whose lease, session-close,
 * and Metro groups answer with plain success. Every other method throws `unexpected call`.
 */
export function createTestClient(
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
      prepare: options.prepare ?? (async () => metroPrepareResult()),
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

export type ConnectionWorkspace = {
  tempRoot: string;
  stateDir: string;
  remoteConfigPath: string;
};

/** A scratch state directory and the path of its remote-config profile, which is not yet written. */
export function connectionWorkspace(prefix: string): ConnectionWorkspace {
  const tempRoot = mkdtempForTestSync(prefix);
  return {
    tempRoot,
    stateDir: path.join(tempRoot, '.state'),
    remoteConfigPath: path.join(tempRoot, 'remote.json'),
  };
}

export type StoredConnectionSeed = Omit<
  RemoteConnectionState,
  'version' | 'remoteConfigHash' | 'connectedAt' | 'updatedAt'
>;

/**
 * Persists a connection recorded against the profile file as it exists now: the stored hash is
 * taken at seed time, so a later edit of `state.remoteConfigPath` reads as a changed profile.
 */
export function seedConnectionState(options: {
  stateDir: string;
  state: StoredConnectionSeed;
}): RemoteConnectionState {
  const state: RemoteConnectionState = {
    version: 1,
    remoteConfigHash: hashRemoteConfigFile(options.state.remoteConfigPath),
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...options.state,
  };
  writeRemoteConnectionState({ stateDir: options.stateDir, state });
  return state;
}

export type LeaseAllocateRequest = Parameters<AgentDeviceClient['leases']['allocate']>[0];
export type LeaseReleaseRequest = Parameters<AgentDeviceClient['leases']['release']>[0];

/** A `leases.release` stub that reports success and keeps the last request it received. */
export function recordedLeaseRelease(): {
  stub: AgentDeviceClient['leases']['release'];
  readonly request: LeaseReleaseRequest | undefined;
} {
  let request: LeaseReleaseRequest | undefined;
  return {
    stub: async (incoming) => {
      request = incoming;
      return { released: true };
    },
    get request() {
      return request;
    },
  };
}

/**
 * A `leases.allocate` stub that grants `leaseId` under the request's own scope and provider
 * fields, and keeps the last request it received.
 */
export function recordedLeaseAllocate(options: {
  leaseId: string;
  backend: NonNullable<LeaseAllocateRequest['leaseBackend']>;
}): {
  stub: AgentDeviceClient['leases']['allocate'];
  readonly request: LeaseAllocateRequest | undefined;
} {
  let request: LeaseAllocateRequest | undefined;
  return {
    stub: async (incoming) => {
      request = incoming;
      return {
        leaseId: options.leaseId,
        tenantId: incoming.tenant,
        runId: incoming.runId,
        backend: incoming.leaseBackend ?? options.backend,
        leaseProvider: incoming.leaseProvider,
        clientId: incoming.clientId,
        deviceKey: incoming.deviceKey,
      };
    },
    get request() {
      return request;
    },
  };
}

export type ReplacedProfiles = {
  oldRemoteConfigPath: string;
  newRemoteConfigPath: string;
};

/**
 * Two profile files in one workspace: the previous connection's, describing https://old.example
 * with `previousToken` when given, and the one `connect --force` moves to, describing
 * https://new.example.
 */
export function writeReplacedProfiles(
  tempRoot: string,
  options: { previousToken?: string } = {},
): ReplacedProfiles {
  const oldRemoteConfigPath = path.join(tempRoot, 'old-remote.json');
  const newRemoteConfigPath = path.join(tempRoot, 'new-remote.json');
  fs.writeFileSync(
    oldRemoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://old.example',
      ...(options.previousToken ? { daemonAuthToken: options.previousToken } : {}),
    }),
  );
  fs.writeFileSync(newRemoteConfigPath, JSON.stringify({ daemonBaseUrl: 'https://new.example' }));
  return { oldRemoteConfigPath, newRemoteConfigPath };
}

/**
 * Persists the connection a `connect --force` replaces: session `adc-android` holding lease
 * `lease-old` under run `run-old` against https://old.example.
 */
export function seedPreviousConnection(options: {
  stateDir: string;
  remoteConfigPath: string;
  overrides?: Partial<StoredConnectionSeed>;
}): RemoteConnectionState {
  return seedConnectionState({
    stateDir: options.stateDir,
    state: {
      session: 'adc-android',
      remoteConfigPath: options.remoteConfigPath,
      tenant: 'acme',
      runId: 'run-old',
      leaseId: 'lease-old',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://old.example' },
      ...options.overrides,
    },
  });
}

/** `connect --force` flags that move session `adc-android` to run `run-new` at https://new.example. */
export function forceConnectFlags(
  options: { stateDir: string; remoteConfig: string } & Partial<CliFlags>,
): CliFlags {
  return {
    json: true,
    help: false,
    version: false,
    force: true,
    daemonBaseUrl: 'https://new.example',
    tenant: 'acme',
    runId: 'run-new',
    session: 'adc-android',
    platform: 'android',
    ...options,
  };
}
