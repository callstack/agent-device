import http from 'node:http';
import { vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { ComposeDaemonRuntimeDeps, DaemonRuntimeDeps } from '@agent-device/daemon';
import type { JsonObject } from '@agent-device/contracts/client';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { composeDaemonRuntimeDeps } from '../../daemon-composition.ts';

type Gateway = DaemonRuntimeDeps['deviceRuntimeGateway'];

export function recordingDaemonHost(options: Parameters<typeof createTestHostEnvironment>[0] = {}) {
  return createTestHostEnvironment({
    ...options,
    env: { ...options.env, AGENT_DEVICE_CLAIMS_DIR: mkdtempForTestSync('recording-test-claims-') },
  });
}

export function recordingDaemonDeps(
  gateway: (composed: Gateway) => Gateway,
): ComposeDaemonRuntimeDeps {
  return async (input) => {
    const deps = await composeDaemonRuntimeDeps(input, []);
    return {
      ...deps,
      deviceRuntimeGateway: gateway(deps.deviceRuntimeGateway),
      ownerLifecycle: {
        configureForDaemonLock: async () => {},
        clearDaemonLockConfiguration: async () => {},
        recoverLegacyAppLogMarkers: async () => ({ recovered: [], retained: [] }),
        cleanupManagedWebOrphans: async () => {},
        resetAndroidSnapshotHelper: async () => {},
      },
      cleanupManagedWebOrphans: async () => {},
    };
  };
}

export function recordingRecoveryEnvelope(descriptor: JsonObject) {
  const device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'fixture',
    kind: 'emulator',
  } as const;
  return createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: 'session',
    device: deviceIdentity(device),
    owner: localRuntimeOwner(device.platform),
    fence: { token: 'test-screen-recording', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: descriptor },
    metadata: { phase: 'active' },
  });
}

export function failDaemonHttpListen(
  failure: Error,
  options: { bindFirst?: boolean; beforeFailure?: () => Promise<void> } = {},
) {
  const createServer = http.createServer;
  return vi.spyOn(http, 'createServer').mockImplementation(((
    ...args: Parameters<typeof http.createServer>
  ) => {
    const server = createServer(...args);
    const listen = server.listen.bind(server);
    server.listen = ((port: number, hostname: string) => {
      const fail = () => {
        void Promise.resolve()
          .then(options.beforeFailure)
          .then(
            () => server.emit('error', failure),
            (error: unknown) => server.emit('error', error),
          );
      };
      if (options.bindFirst) listen(port, hostname, fail);
      else queueMicrotask(fail);
      return server;
    }) as typeof server.listen;
    return server;
  }) as typeof http.createServer);
}
