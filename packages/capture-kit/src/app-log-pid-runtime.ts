import type { DeviceInfo, Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AppLogProcessCommand,
  AppLogProcessTransport,
  AppLogRuntimeHost,
  AppLogRuntimeOperations,
  AppLogSessionArtifacts,
  AppLogStartInput,
  AppLogStartResult,
  DeviceBinding,
  DeviceRuntimeOwner,
  DurableDescriptorCodec,
  DurableResourceEnvelope,
  HostCommandRequest,
  RuntimeFacts,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { LogBackend } from '@agent-device/contracts/observability';
import { createAppLogRecoveryOperations, createAppLogStartResult } from './app-log-runtime.ts';
import {
  cleanupManagedAppLogProcess,
  reattachCleanupOnlyAppLogProcess,
} from './app-log-process-recovery.ts';
import { createPidScopedAppLogProcess } from './app-log-pid-process.ts';
import {
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
} from './app-log-session-artifacts.ts';

type PidScopedDescriptorPaths = Readonly<{
  outputPath: string;
  pidPath: string;
}>;

export type PidScopedAppLogRuntimeContext = Readonly<{
  host: AppLogRuntimeHost;
  device: DeviceInfo;
  signal: AbortSignal;
}>;

export type PidScopedAppLogStartContext = PidScopedAppLogRuntimeContext &
  Readonly<{
    input: AppLogStartInput;
    artifacts: AppLogSessionArtifacts;
    transport: AppLogProcessTransport;
  }>;

export type PidScopedAppLogProcessPlan = Readonly<{
  resolvePid(signal?: AbortSignal): Promise<string>;
  command(pid: string): AppLogProcessCommand;
}>;

type PidScopedAppLogEnvelopeInput<Descriptor extends PidScopedDescriptorPaths> = Readonly<{
  input: AppLogStartInput;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  descriptor: Descriptor;
}>;

export type PidScopedAppLogRuntimeOptions<
  Family extends Platform,
  Descriptor extends PidScopedDescriptorPaths,
> = Readonly<{
  family: Family;
  backend: LogBackend;
  label: string;
  codec: DurableDescriptorCodec<Descriptor, 'app-log'>;
  startUnavailableHint: string;
  cleanupFailureMessage: string;
  doctor(
    context: PidScopedAppLogRuntimeContext,
    appBundleId: string | undefined,
  ): ReturnType<AppLogRuntimeOperations['appLogDoctor']>;
  validateStart?(context: PidScopedAppLogStartContext): void;
  process(context: PidScopedAppLogStartContext): Promise<PidScopedAppLogProcessPlan>;
  descriptor(input: {
    artifacts: AppLogSessionArtifacts;
    transport: AppLogProcessTransport;
  }): Descriptor;
  envelope(input: PidScopedAppLogEnvelopeInput<Descriptor>): DurableResourceEnvelope<'app-log'>;
}>;

const available = Object.freeze({ available: true } as const);

export async function resolveFirstNumericAppLogPid(
  host: AppLogRuntimeHost,
  request: HostCommandRequest,
  signal?: AbortSignal,
): Promise<string> {
  const result = await host.commands.run(request, signal);
  const pid = result.stdout.trim().split(/\s+/)[0] ?? '';
  return /^\d+$/.test(pid) ? pid : '';
}

/** Owns binding, facts, canonical artifacts, process lifecycle, and cleanup-only recovery. */
export function createPidScopedAppLogRuntimeOwner<
  Family extends Platform,
  Descriptor extends PidScopedDescriptorPaths,
>(
  host: AppLogRuntimeHost,
  options: PidScopedAppLogRuntimeOptions<Family, Descriptor>,
): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  const owner = localRuntimeOwner(options.family);
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === options.family,
    inspectFacts: async (device) => {
      const transport = await host.processTransports.resolve(device);
      return createFacts(device, transport, options);
    },
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          `${options.label} app-log owner identity does not match`,
        );
      }
      if (request.device.platform !== options.family) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          `${options.label} app-log owner cannot bind ${request.device.platform}`,
        );
      }
      const transport = await host.processTransports.resolve(request.device);
      return createBinding(host, request.device, request.scope.signal, transport, owner, options);
    },
    shutdown: async () => undefined,
  });
}

function createBinding<Family extends Platform, Descriptor extends PidScopedDescriptorPaths>(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
  transport: AppLogProcessTransport,
  owner: RuntimeOwnerRef,
  options: PidScopedAppLogRuntimeOptions<Family, Descriptor>,
): DeviceBinding<AppLogRuntimeOperations> {
  const recovery = createAppLogRecoveryOperations({
    codec: options.codec,
    reattach: async (descriptor, context) => {
      if (!appLogSessionArtifactsMatch(host, context.sessionId, descriptor)) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message: `${options.label} app-log descriptor paths do not match the owning session`,
        };
      }
      return await reattachCleanupOnlyAppLogProcess(host, descriptor.pidPath);
    },
    cleanup: async (descriptor, context) => {
      if (!appLogSessionArtifactsMatch(host, context.sessionId, descriptor)) {
        return {
          status: 'cleanup-pending',
          reason: 'ownership-fence-lost',
          message: `${options.label} app-log descriptor paths do not match the owning session`,
        } as const;
      }
      return await cleanupManagedAppLogProcess(host, descriptor.pidPath);
    },
  });
  const operations: DeviceBinding<AppLogRuntimeOperations>['operations'] = Object.freeze({
    appLogInspect: async () => ({ backend: options.backend }),
    appLogDoctor: async ({ appBundleId }) =>
      await options.doctor({ host, device, signal }, appBundleId),
    ...(transport.start
      ? {
          appLogStart: async (input: AppLogStartInput) =>
            await startPidScopedAppLogs(host, device, signal, transport, owner, input, options),
        }
      : {}),
    ...recovery,
  });
  return Object.freeze({
    device,
    owner,
    facts: createFacts(device, transport, options),
    operations,
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function createFacts<Family extends Platform, Descriptor extends PidScopedDescriptorPaths>(
  device: DeviceInfo,
  transport: AppLogProcessTransport,
  options: PidScopedAppLogRuntimeOptions<Family, Descriptor>,
): RuntimeFacts<AppLogRuntimeOperations> {
  const start = transport.start
    ? available
    : ({
        available: false,
        reason: 'owner-capability-missing',
        hint: options.startUnavailableHint,
      } as const);
  return Object.freeze({
    device: {
      family: options.family,
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: transport.mode,
    },
    operations: {
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: start,
      appLogReattach: available,
      appLogCleanup: available,
    },
  });
}

async function startPidScopedAppLogs<
  Family extends Platform,
  Descriptor extends PidScopedDescriptorPaths,
>(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
  transport: AppLogProcessTransport,
  owner: RuntimeOwnerRef,
  input: AppLogStartInput,
  options: PidScopedAppLogRuntimeOptions<Family, Descriptor>,
): Promise<AppLogStartResult> {
  if (!transport.start) {
    throw new AppError('UNSUPPORTED_OPERATION', options.startUnavailableHint);
  }
  assertAppLogSessionArtifacts(host, input);
  const artifacts = host.artifacts.resolveSession(input.sessionId);
  const context = { host, device, signal, input, artifacts, transport } as const;
  options.validateStart?.(context);
  signal.throwIfAborted();
  const process = await options.process(context);
  signal.throwIfAborted();
  const handle = await createPidScopedAppLogProcess({
    host,
    backend: options.backend,
    outputPath: artifacts.outputPath,
    pidPath: artifacts.pidPath,
    processStart: transport.start,
    setupSignal: signal,
    resolvePid: process.resolvePid,
    command: process.command,
    cleanupFailureMessage: options.cleanupFailureMessage,
  });
  const descriptor = options.descriptor({ artifacts, transport });
  return createAppLogStartResult(handle, options.envelope({ input, device, owner, descriptor }));
}
