import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  APP_LOG_RESOURCE_KIND,
  type AppLogRuntimeHost,
  type AppLogRuntimeOperations,
} from '@agent-device/contracts/app-log-runtime';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';
import type {
  NetworkRuntimeHost,
  NetworkRuntimeOperations,
} from '@agent-device/contracts/network-runtime';
import type { LogBackend } from '@agent-device/contracts/observability';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { createAppLogRecoveryOperations, createAppLogStartResult } from './app-log-runtime.ts';
import {
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
} from './app-log-session-artifacts.ts';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
} from './durable-resource-envelope.ts';
import { readRecentNetworkTrafficFromText } from './network-traffic.ts';
import { startProviderAppLogPoller, type ProviderAppLogReader } from './provider-app-log-poller.ts';

export type { ProviderAppLogReader } from './provider-app-log-poller.ts';

/** The fields every provider app-log descriptor carries; providers add their instance identity. */
export type ProviderAppLogTarget = Readonly<{ appBundleId: string; outputPath: string }>;

export type ProviderAppLogReconnectOutcome<Reader extends ProviderAppLogReader> =
  | Readonly<{ status: 'opened'; reader: Reader }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ownership-lost' }>;

export type ProviderAppLogOptions<
  Descriptor extends ProviderAppLogTarget,
  Reader extends ProviderAppLogReader,
> = Readonly<{
  host: Pick<AppLogRuntimeHost, 'artifacts' | 'outputs' | 'clock'> &
    Pick<NetworkRuntimeHost, 'appLogs'>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
  /** Names the provider in user-visible messages. */
  provider: string;
  backend: LogBackend;
  /** `appLogDoctor` check key reporting whether a current reader opens. */
  sessionCheck: string;
  /** Raised by `appLogStart` when the provider has no current reader. */
  unavailableMessage: string;
  codec: DurableDescriptorCodec<Descriptor, typeof APP_LOG_RESOURCE_KIND>;
  openCurrent(): Promise<Reader | undefined>;
  describe(reader: Reader, target: ProviderAppLogTarget): Descriptor;
  /** Whether a persisted descriptor names the bound device; checked before any reconnect. */
  matchesDevice(descriptor: Descriptor): boolean;
  reconnect(
    descriptor: Descriptor,
    signal: AbortSignal,
  ): Promise<ProviderAppLogReconnectOutcome<Reader>>;
}>;

/**
 * App-log and app-log-backed network operations for a provider that reads its log tail remotely.
 * The provider supplies reader acquisition and descriptor identity; polling, the durable envelope,
 * reattach, and cleanup are shared.
 */
export function createProviderAppLogOperations<
  Descriptor extends ProviderAppLogTarget,
  Reader extends ProviderAppLogReader,
>(
  options: ProviderAppLogOptions<Descriptor, Reader>,
): AppLogRuntimeOperations & NetworkRuntimeOperations {
  const { host, signal } = options;
  const mismatch = `${options.provider} app-log descriptor does not match the bound device or owning session`;
  const ownsDescriptor = (descriptor: Descriptor, sessionId: string) =>
    options.matchesDevice(descriptor) && appLogSessionArtifactsMatch(host, sessionId, descriptor);
  const startPoller = async (reader: Reader, target: ProviderAppLogTarget) =>
    await startProviderAppLogPoller({
      host,
      provider: options.provider,
      backend: options.backend,
      reader,
      appBundleId: target.appBundleId,
      outputPath: target.outputPath,
    });
  const recovery = createAppLogRecoveryOperations({
    codec: options.codec,
    reattach: async (descriptor, context) => {
      if (!ownsDescriptor(descriptor, context.sessionId)) {
        return { status: 'unreattachable', reason: 'descriptor-invalid', message: mismatch };
      }
      const reconnected = await options.reconnect(descriptor, signal);
      if (reconnected.status === 'missing') return { status: 'missing' };
      if (reconnected.status === 'ownership-lost') {
        return { status: 'unreattachable', reason: 'ownership-fence-lost' };
      }
      return { status: 'active', handle: await startPoller(reconnected.reader, descriptor) };
    },
    cleanup: async (descriptor, context) =>
      ownsDescriptor(descriptor, context.sessionId)
        ? { status: 'cleaned' }
        : { status: 'cleanup-pending', reason: 'ownership-fence-lost', message: mismatch },
  });
  return Object.freeze({
    appLogInspect: async () => ({ backend: options.backend }),
    appLogDoctor: async () => ({
      backend: options.backend,
      checks: { [options.sessionCheck]: await currentReaderOpens(options) },
      notes: [],
    }),
    appLogStart: async (input) => {
      assertAppLogSessionArtifacts(host, input);
      signal.throwIfAborted();
      const reader = await options.openCurrent();
      if (!reader) throw new AppError('UNSUPPORTED_OPERATION', options.unavailableMessage);
      let pollerOwnsReader = false;
      try {
        signal.throwIfAborted();
        const envelope = createProviderAppLogEnvelope({
          provider: options.provider,
          codec: options.codec,
          sessionId: input.sessionId,
          device: options.device,
          owner: options.owner,
          fence: input.fence,
          descriptor: options.describe(reader, input),
        });
        pollerOwnsReader = true;
        return createAppLogStartResult(await startPoller(reader, input), envelope);
      } catch (error) {
        if (!pollerOwnsReader) await reader[Symbol.asyncDispose]();
        throw error;
      }
    },
    ...recovery,
    networkDump: async (input) => {
      const recent = await host.appLogs.readRecent(input.sessionId, input.maxScanLines);
      const { dump } = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend: options.backend,
      });
      const notes =
        dump.entries.length === 0
          ? ['No HTTP(s) entries were found in recent session app logs.']
          : [];
      return Object.freeze({ source: 'app-log' as const, backend: options.backend, dump, notes });
    },
  });
}

export function createProviderAppLogEnvelope<Descriptor extends ProviderAppLogTarget>(input: {
  provider: string;
  codec: DurableDescriptorCodec<Descriptor, typeof APP_LOG_RESOURCE_KIND>;
  sessionId: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: { token: string; generation: number };
  descriptor: Descriptor;
}): DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND> {
  const { device } = input;
  if (device.platform === 'apple' && !device.appleOs) {
    throw new TypeError(
      `${input.provider} Apple app-log persistence requires an explicit appleOs identity`,
    );
  }
  return createDurableResourceEnvelope({
    resourceKind: APP_LOG_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: {
      id: device.id,
      family: device.platform,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      ...(device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
    },
    owner: input.owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(input.codec, input.descriptor),
  });
}

async function currentReaderOpens<Reader extends ProviderAppLogReader>(
  options: Pick<ProviderAppLogOptions<ProviderAppLogTarget, Reader>, 'openCurrent' | 'signal'>,
): Promise<boolean> {
  options.signal.throwIfAborted();
  const reader = await options.openCurrent();
  if (!reader) return false;
  try {
    options.signal.throwIfAborted();
  } finally {
    await reader[Symbol.asyncDispose]();
  }
  return true;
}
