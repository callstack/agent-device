import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AppLogRuntimeHost,
  AppLogRuntimeOperations,
  AppLogProcessTransport,
  AppLogStartInput,
  AppLogStartResult,
  DeviceBinding,
  DeviceRuntimeOwner,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import {
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
  cleanupManagedAppLogProcess,
  createPidScopedAppLogProcess,
  createAppLogRecoveryOperations,
  createAppLogStartResult,
  localRuntimeOwner,
  reattachCleanupOnlyAppLogProcess,
  resolveFirstNumericAppLogPid,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform';
import {
  createHarmonyAppLogEnvelope,
  harmonyAppLogDescriptorCodec,
  type HarmonyAppLogDescriptor,
} from './descriptor.ts';

const owner = localRuntimeOwner('harmonyos');
const available = Object.freeze({ available: true } as const);

export function createHarmonyAppLogRuntime(
  host: AppLogRuntimeHost,
): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'harmonyos',
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'HarmonyOS app-log owner identity does not match',
        );
      }
      const processTransport = await host.processTransports.resolve(request.device);
      return bindHarmonyAppLogs(host, request.device, request.scope.signal, processTransport);
    },
    shutdown: async () => undefined,
  });
}

function bindHarmonyAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
  processTransport: AppLogProcessTransport,
): DeviceBinding<AppLogRuntimeOperations> {
  if (device.platform !== 'harmonyos') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `HarmonyOS app-log owner cannot bind ${device.platform}`,
    );
  }
  const recovery = createAppLogRecoveryOperations({
    codec: harmonyAppLogDescriptorCodec,
    reattach: async (descriptor, context) => {
      if (!appLogSessionArtifactsMatch(host, context.sessionId, descriptor)) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message: 'HarmonyOS app-log descriptor paths do not match the owning session',
        };
      }
      return await reattachCleanupOnlyAppLogProcess(host, descriptor.pidPath);
    },
    cleanup: async (descriptor, context) =>
      appLogSessionArtifactsMatch(host, context.sessionId, descriptor)
        ? await cleanupManagedAppLogProcess(host, descriptor.pidPath)
        : {
            status: 'cleanup-pending',
            reason: 'ownership-fence-lost',
            message: 'HarmonyOS app-log descriptor paths do not match the owning session',
          },
  });
  const operations: DeviceBinding<AppLogRuntimeOperations>['operations'] = {
    appLogInspect: async () => ({ backend: 'harmonyos' as const }),
    appLogDoctor: async ({ appBundleId }) => ({
      backend: 'harmonyos',
      checks: {},
      notes: appBundleId
        ? []
        : ['No app bundle is tracked in this session. Run open <app> first for app-scoped logs.'],
    }),
    ...(processTransport.start
      ? {
          appLogStart: async (input) =>
            await startHarmonyAppLogs(host, device, input, signal, processTransport),
        }
      : {}),
    ...recovery,
  };
  return Object.freeze({
    device,
    owner,
    facts: harmonyAppLogFacts(device, processTransport),
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function harmonyAppLogFacts(
  device: DeviceInfo,
  processTransport: AppLogProcessTransport,
): RuntimeFacts<AppLogRuntimeOperations> {
  const start = processTransport.start
    ? available
    : ({
        available: false,
        reason: 'owner-capability-missing',
        hint: 'The selected HarmonyOS transport cannot start a background hilog stream.',
      } as const);
  return Object.freeze({
    device: {
      family: 'harmonyos',
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: processTransport.mode,
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

async function startHarmonyAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  input: AppLogStartInput,
  signal: AbortSignal,
  processTransport: AppLogProcessTransport,
): Promise<AppLogStartResult> {
  if (!processTransport.start) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The selected HarmonyOS transport cannot start a background hilog stream.',
    );
  }
  assertAppLogSessionArtifacts(host, input);
  signal.throwIfAborted();
  await host.toolchains.prepare('harmonyos');
  signal.throwIfAborted();
  const hdc = await host.commands.which('hdc');
  signal.throwIfAborted();
  if (!hdc) {
    throw new AppError('TOOL_MISSING', 'hdc not found in PATH', {
      hint: 'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH.',
    });
  }
  const handle = await createPidScopedAppLogProcess({
    host,
    backend: 'harmonyos',
    outputPath: input.outputPath,
    ...(input.pidPath === undefined ? {} : { pidPath: input.pidPath }),
    processStart: processTransport.start,
    setupSignal: signal,
    resolvePid: async (pidSignal) =>
      await resolveFirstNumericAppLogPid(
        host,
        {
          executable: hdc,
          args: ['-t', device.id, 'shell', 'pidof', input.appBundleId],
          allowFailure: true,
          timeoutMs: 5_000,
        },
        pidSignal,
      ),
    command: (pid) => ({
      executable: hdc,
      args: ['-t', device.id, 'shell', 'hilog', '-P', pid],
      allowFailure: true,
    }),
    cleanupFailureMessage: 'HarmonyOS app-log cleanup did not settle every owned resource',
  });
  const descriptor: HarmonyAppLogDescriptor = {
    transport: 'harmony-hilog',
    outputPath: input.outputPath,
    ...(input.pidPath === undefined ? {} : { pidPath: input.pidPath }),
  };
  return createAppLogStartResult(
    handle,
    createHarmonyAppLogEnvelope({
      sessionId: input.sessionId,
      device,
      owner,
      fence: input.fence,
      descriptor,
    }),
  );
}
