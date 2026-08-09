import type Limrun from '@limrun/api';
import { NotFoundError } from '@limrun/api';
import { createInstanceClient as createAndroidInstanceClient } from '@limrun/api/instance-client';
import { createInstanceClient as createIosInstanceClient } from '@limrun/api/ios-client';
import { AsyncCleanupStack } from '@agent-device/contracts/platform';
import type { LimrunAppLogDescriptor } from './app-log-descriptor.ts';
import type { LimrunAppLogReader } from './app-log-poller.ts';
import type { LimrunAppLogReconnectOutcome } from './app-log-runtime.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

export async function reconnectLimrunAppLogReader(options: {
  limrun: Limrun;
  descriptor: LimrunAppLogDescriptor;
  dependencies: LimrunRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<LimrunAppLogReconnectOutcome> {
  try {
    return options.descriptor.platform === 'ios'
      ? await reconnectIos(options)
      : await reconnectAndroid(options);
  } catch (error) {
    if (error instanceof NotFoundError) return { status: 'missing' };
    throw error;
  }
}

async function reconnectIos(options: {
  limrun: Limrun;
  descriptor: LimrunAppLogDescriptor;
  signal?: AbortSignal;
}): Promise<LimrunAppLogReconnectOutcome> {
  const instance = await options.limrun.iosInstances.get(options.descriptor.instanceId, {
    timeout: 5_000,
    maxRetries: 0,
    signal: options.signal,
  });
  if (!hasDescriptorOwnership(instance.metadata.labels, options.descriptor)) {
    return { status: 'ownership-lost' };
  }
  if (instance.status.state === 'terminated') return { status: 'missing' };
  if (!instance.status.apiUrl) return { status: 'missing' };
  const client = await createIosInstanceClient({
    apiUrl: instance.status.apiUrl,
    token: instance.status.token,
    logLevel: 'warn',
  });
  const reader: LimrunAppLogReader = {
    platform: 'ios',
    leaseId: options.descriptor.leaseId,
    instanceId: options.descriptor.instanceId,
    readLogs: async (appBundleId, lineLimit) => await client.appLogTail(appBundleId, lineLimit),
    [Symbol.asyncDispose]: async () => client.disconnect(),
  };
  return { status: 'opened', reader };
}

async function reconnectAndroid(options: {
  limrun: Limrun;
  descriptor: LimrunAppLogDescriptor;
  dependencies: LimrunRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<LimrunAppLogReconnectOutcome> {
  const instance = await options.limrun.androidInstances.get(options.descriptor.instanceId, {
    timeout: 5_000,
    maxRetries: 0,
    signal: options.signal,
  });
  if (!hasDescriptorOwnership(instance.metadata.labels, options.descriptor)) {
    return { status: 'ownership-lost' };
  }
  if (instance.status.state === 'terminated') return { status: 'missing' };
  if (!instance.status.apiUrl || !instance.status.adbWebSocketUrl) return { status: 'missing' };
  const client = await createAndroidInstanceClient({
    apiUrl: instance.status.apiUrl,
    adbUrl: instance.status.adbWebSocketUrl,
    token: instance.status.token,
    logLevel: 'warn',
  });
  const rollback = new AsyncCleanupStack();
  let adopted = false;
  rollback.defer(async () => {
    if (!adopted) client.disconnect();
  });
  try {
    const tunnel = await client.startAdbTunnel();
    rollback.defer(async () => {
      if (!adopted) tunnel.close();
    });
    const serial = `${tunnel.address.address}:${tunnel.address.port}`;
    const adb = async (
      args: string[],
      commandOptions?: Parameters<LimrunRuntimeDependencies['host']['runAdb']>[1],
    ) => await options.dependencies.host.runAdb(['-s', serial, ...args], commandOptions);
    const reader: LimrunAppLogReader = {
      platform: 'android',
      leaseId: options.descriptor.leaseId,
      instanceId: options.descriptor.instanceId,
      readLogs: async (_appBundleId, lineLimit) =>
        await options.dependencies.android.readLogs(adb, lineLimit),
      [Symbol.asyncDispose]: async () => {
        await options.dependencies.host
          .runAdb(['disconnect', serial], { allowFailure: true, timeoutMs: 10_000 })
          .catch(() => undefined);
        const results = await Promise.allSettled([
          Promise.resolve().then(() => tunnel.close()),
          Promise.resolve().then(() => client.disconnect()),
        ]);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Limrun Android app-log reader cleanup failed');
        }
      },
    };
    adopted = true;
    return { status: 'opened', reader };
  } finally {
    await rollback[Symbol.asyncDispose]();
  }
}

function hasDescriptorOwnership(
  labels: Record<string, string> | undefined,
  descriptor: LimrunAppLogDescriptor,
): boolean {
  return labels?.provider === 'limrun' && labels.leaseId === descriptor.leaseId;
}
