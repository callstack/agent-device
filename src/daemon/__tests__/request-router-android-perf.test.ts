import { expect, test } from 'vitest';
import { createRequestHandler } from '../request-router.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { SessionStore } from '../session-store.ts';
import { AppError } from '../../kernel/errors.ts';
import type {
  AndroidAdbExecutor,
  AndroidAdbProvider,
} from '../../platforms/android/adb-executor.ts';

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
  return createRequestHandler({
    logPath: '/tmp/daemon.log',
    token: 'token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    androidAdbProvider,
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

test('request handler reports injected Android adb failures per perf metric', async () => {
  const sessionStore = makeAndroidSessionStore('agent-device-request-router-perf-unavailable-test');
  const adb: AndroidAdbExecutor = async () => {
    throw new AppError('COMMAND_FAILED', 'Remote Android ADB executor is unavailable');
  };
  const handler = makeHandler(sessionStore, () => ({ exec: adb }));

  const response = await handler({
    token: 'token',
    session: 'default',
    command: 'perf',
    positionals: [],
    flags: {},
  });

  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('Expected perf response to succeed');
  const metrics = response.data?.metrics as Record<string, any>;
  for (const metricName of ['memory', 'cpu', 'fps']) {
    const metric = metrics[metricName];
    expect(metric.available).toBe(false);
    expect(metric.reason).toBe('Remote Android ADB executor is unavailable');
    expect(metric.error.details.metric).toBe(metricName);
  }
});
