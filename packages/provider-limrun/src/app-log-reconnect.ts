import type Limrun from '@limrun/api';
import { createInstanceClient as createAndroidInstanceClient } from '@limrun/api/instance-client';
import { createInstanceClient as createIosInstanceClient } from '@limrun/api/ios-client';
import { AsyncCleanupStack } from '@agent-device/contracts/async-lifecycle';
import type { LimrunAppLogDescriptor } from './app-log-descriptor.ts';
import type { LimrunAppLogReader, LimrunAppLogReconnectOutcome } from './app-log-runtime.ts';
import { fromLimrunOrgApi, isLimrunApiNotFound, requireLimrunOrgClient } from './client-options.ts';
import { connectLimrunInstanceClient } from './instance-error-scrubbing.ts';
import { readLimrunAndroidLogs, runLimrunAndroidAdbCommand } from './android.ts';
import { attachedLimrunInstanceId } from './device.ts';
import type {
  LimrunAndroidInstanceAccess,
  LimrunInstanceAccess,
  LimrunIosInstanceAccess,
} from './instance-access.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

export async function reconnectLimrunAppLogReader(options: {
  limrun?: Limrun;
  instances?: LimrunInstanceAccess;
  descriptor: LimrunAppLogDescriptor;
  dependencies: LimrunRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<LimrunAppLogReconnectOutcome> {
  options.signal?.throwIfAborted();
  if (options.descriptor.ownership === 'attached') {
    return await reconnectAttached(
      options.instances ?? {},
      options.descriptor,
      options.dependencies,
    );
  }
  const limrun = requireLimrunOrgClient(options.limrun, 'Reconnecting app logs');
  return options.descriptor.platform === 'ios'
    ? await reconnectIos({ ...options, limrun })
    : await reconnectAndroid({ ...options, limrun });
}

async function reconnectAttached(
  instances: LimrunInstanceAccess,
  descriptor: LimrunAppLogDescriptor,
  dependencies: LimrunRuntimeDependencies,
): Promise<LimrunAppLogReconnectOutcome> {
  if (descriptor.platform === 'ios') {
    return isDescribedInstance(instances.ios, descriptor)
      ? await openIosReader(instances.ios, descriptor, dependencies)
      : { status: 'ownership-lost' };
  }
  return isDescribedInstance(instances.android, descriptor)
    ? await openAndroidReader(instances.android, descriptor, dependencies)
    : { status: 'ownership-lost' };
}

function isDescribedInstance<Access extends LimrunIosInstanceAccess>(
  access: Access | undefined,
  descriptor: LimrunAppLogDescriptor,
): access is Access {
  return access !== undefined && attachedLimrunInstanceId(access.apiUrl) === descriptor.instanceId;
}

async function reconnectIos(options: {
  limrun: Limrun;
  descriptor: LimrunAppLogDescriptor;
  dependencies: LimrunRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<LimrunAppLogReconnectOutcome> {
  const selected = await selectOwnedActiveInstance(
    async () =>
      await options.limrun.iosInstances.get(options.descriptor.instanceId, {
        timeout: 5_000,
        maxRetries: 0,
        signal: options.signal,
      }),
    options.descriptor,
  );
  if (selected.status !== 'active') return selected;
  return await openIosReader(
    { apiUrl: selected.apiUrl, token: selected.token },
    options.descriptor,
    options.dependencies,
  );
}

async function openIosReader(
  access: LimrunIosInstanceAccess,
  descriptor: LimrunAppLogDescriptor,
  dependencies: LimrunRuntimeDependencies,
): Promise<LimrunAppLogReconnectOutcome> {
  const client = await connectLimrunInstanceClient(createIosInstanceClient, access);
  const logs = dependencies.ios.createAppLogReader({ ...access, client });
  const reader: LimrunAppLogReader = {
    platform: 'ios',
    leaseId: descriptor.leaseId,
    instanceId: descriptor.instanceId,
    ownership: descriptor.ownership,
    readLogs: logs.readLogs,
    [Symbol.asyncDispose]: async () => {
      try {
        await logs[Symbol.asyncDispose]();
      } finally {
        client.disconnect();
      }
    },
  };
  return { status: 'opened', reader };
}

async function reconnectAndroid(options: {
  limrun: Limrun;
  descriptor: LimrunAppLogDescriptor;
  dependencies: LimrunRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<LimrunAppLogReconnectOutcome> {
  const selected = await selectOwnedActiveInstance(
    async () =>
      await options.limrun.androidInstances.get(options.descriptor.instanceId, {
        timeout: 5_000,
        maxRetries: 0,
        signal: options.signal,
      }),
    options.descriptor,
  );
  if (selected.status !== 'active') return selected;
  const { instance } = selected;
  if (!instance.status.adbWebSocketUrl) return { status: 'missing' };
  return await openAndroidReader(
    {
      apiUrl: selected.apiUrl,
      adbUrl: instance.status.adbWebSocketUrl,
      token: selected.token,
    },
    options.descriptor,
    options.dependencies,
  );
}

async function openAndroidReader(
  access: LimrunAndroidInstanceAccess,
  descriptor: LimrunAppLogDescriptor,
  dependencies: LimrunRuntimeDependencies,
): Promise<LimrunAppLogReconnectOutcome> {
  const client = await connectLimrunInstanceClient(createAndroidInstanceClient, access);
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
      args: readonly string[],
      commandOptions?: Parameters<LimrunRuntimeDependencies['host']['runAdb']>[1],
    ) =>
      await runLimrunAndroidAdbCommand(
        dependencies,
        access.token,
        dependencies.android.deviceAdbInvocation(serial, args),
        commandOptions,
      );
    const reader: LimrunAppLogReader = {
      platform: 'android',
      leaseId: descriptor.leaseId,
      instanceId: descriptor.instanceId,
      ownership: descriptor.ownership,
      readLogs: async (_appBundleId, lineLimit) =>
        await readLimrunAndroidLogs(dependencies, access.token, adb, lineLimit),
      [Symbol.asyncDispose]: async () => {
        await dependencies.host
          .runAdb(dependencies.android.hostAdbInvocation(['disconnect', serial]), {
            allowFailure: true,
            timeoutMs: 10_000,
          })
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

type ReconnectableLimrunInstance = Readonly<{
  metadata: Readonly<{ labels?: Record<string, string> }>;
  status: Readonly<{ state: string; apiUrl?: string | null; token?: string }>;
}>;

async function selectOwnedActiveInstance<Instance extends ReconnectableLimrunInstance>(
  load: () => Promise<Instance>,
  descriptor: LimrunAppLogDescriptor,
): Promise<
  | Readonly<{ status: 'active'; instance: Instance; apiUrl: string; token: string }>
  | Extract<LimrunAppLogReconnectOutcome, { status: 'missing' | 'ownership-lost' }>
> {
  let instance: Instance;
  try {
    instance = await fromLimrunOrgApi(load());
  } catch (error) {
    if (isLimrunApiNotFound(error)) return { status: 'missing' };
    throw error;
  }
  if (!hasDescriptorOwnership(instance.metadata.labels, descriptor)) {
    return { status: 'ownership-lost' };
  }
  const { apiUrl, token } = instance.status;
  if (instance.status.state === 'terminated' || !apiUrl || !token) {
    return { status: 'missing' };
  }
  return { status: 'active', instance, apiUrl, token };
}

function hasDescriptorOwnership(
  labels: Record<string, string> | undefined,
  descriptor: LimrunAppLogDescriptor,
): boolean {
  return labels?.provider === 'limrun' && labels.leaseId === descriptor.leaseId;
}
