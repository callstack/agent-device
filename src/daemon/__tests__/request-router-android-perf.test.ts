import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { expect, test } from 'vitest';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { SessionStore } from '../session-store.ts';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AndroidAdbExecutor,
  AndroidAdbProvider,
} from '../../platforms/android/adb-executor.ts';
import {
  createPlatformRuntimeGateway,
  createRequestPlatformProviders,
} from '../../platform-runtime.ts';

function makeAndroidSessionStore(name: string): SessionStore {
  const sessionStore = new SessionStore(`/tmp/${name}`);
  sessionStore.set('default', {
    name: 'default',
    createdAt: Date.now(),
    device: {
      platform: 'android',
      id: 'remote-android-1',
      name: 'Remote Android',
      kind: 'device',
      booted: true,
    },
    appBundleId: 'com.example.app',
    actions: [],
  });
  return sessionStore;
}

function makeHandler(sessionStore: SessionStore, androidAdbProvider: () => AndroidAdbProvider) {
  const deviceRuntimeGateway = createPlatformRuntimeGateway({
    sessionsDir: '/tmp/agent-device-perf-runtime',
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: `/tmp/agent-device-perf-runtime/${sessionId}/app.log`,
      pidPath: `/tmp/agent-device-perf-runtime/${sessionId}/app-log.pid`,
    }),
  });
  return createRequestHandler({
    logPath: '/tmp/daemon.log',
    token: 'token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    requestPlatformProviders: createRequestPlatformProviders({
      providers: { androidAdbProvider },
    }),
    deviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

test('request handler reports injected Android adb failures for memory sampling', async () => {
  const sessionStore = makeAndroidSessionStore('agent-device-request-router-perf-unavailable-test');
  const adb: AndroidAdbExecutor = async () => {
    throw new AppError('COMMAND_FAILED', 'Remote Android ADB executor is unavailable');
  };
  const handler = makeHandler(sessionStore, () => ({ exec: adb }));

  const response = await handler({
    token: 'token',
    session: 'default',
    command: 'perf',
    positionals: ['memory', 'sample'],
    flags: {},
  });

  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('Expected perf response to succeed');
  const metrics = response.data?.metrics as Record<string, any>;
  const memory = metrics.memory;
  expect(memory.available).toBe(false);
  expect(memory.reason).toBe('Remote Android ADB executor is unavailable');
  expect(memory.error.details.metric).toBe('memory');
});
