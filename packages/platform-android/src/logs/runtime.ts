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
  appLogCommandSucceeded,
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
  bestEffortAppLogCheck,
  cleanupManagedAppLogProcess,
  createPidScopedAppLogProcess,
  createAppLogRecoveryOperations,
  createAppLogStartResult,
  localRuntimeOwner,
  reattachCleanupOnlyAppLogProcess,
  resolveFirstNumericAppLogPid,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform';
import { assertAndroidLogPackageSafe } from './package-name.ts';
import {
  androidAppLogDescriptorCodec,
  createAndroidAppLogEnvelope,
  type AndroidAppLogDescriptor,
} from './descriptor.ts';

const owner = localRuntimeOwner('android');
const available = Object.freeze({ available: true } as const);

export function createAndroidAppLogRuntime(
  host: AppLogRuntimeHost,
): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'android',
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Android app-log owner identity does not match',
        );
      }
      const processTransport = await host.processTransports.resolve(request.device);
      return bindAndroidAppLogs(host, request.device, request.scope.signal, processTransport);
    },
    shutdown: async () => undefined,
  });
}

function bindAndroidAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
  processTransport: AppLogProcessTransport,
): DeviceBinding<AppLogRuntimeOperations> {
  if (device.platform !== 'android') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `Android app-log owner cannot bind ${device.platform}`,
    );
  }
  const recovery = createAppLogRecoveryOperations({
    codec: androidAppLogDescriptorCodec,
    reattach: async (descriptor, context) => {
      if (!appLogSessionArtifactsMatch(host, context.sessionId, descriptor)) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message: 'Android app-log descriptor paths do not match the owning session',
        };
      }
      return await reattachCleanupOnlyAppLogProcess(host, descriptor.pidPath);
    },
    cleanup: async (descriptor, context) => {
      if (!appLogSessionArtifactsMatch(host, context.sessionId, descriptor)) {
        return {
          status: 'cleanup-pending',
          reason: 'ownership-fence-lost',
          message: 'Android app-log descriptor paths do not match the owning session',
        } as const;
      }
      return await cleanupManagedAppLogProcess(host, descriptor.pidPath);
    },
  });
  const operations: DeviceBinding<AppLogRuntimeOperations>['operations'] = {
    appLogInspect: async () => ({ backend: 'android' as const }),
    appLogDoctor: async ({ appBundleId }) =>
      await doctorAndroidAppLogs(host, device, appBundleId, signal),
    ...(processTransport.start
      ? {
          appLogStart: async (input) =>
            await startAndroidAppLogs(host, device, input, signal, processTransport),
        }
      : {}),
    ...recovery,
  };
  return Object.freeze({
    device,
    owner,
    facts: androidAppLogFacts(device, processTransport),
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function androidAppLogFacts(
  device: DeviceInfo,
  processTransport: AppLogProcessTransport,
): RuntimeFacts<AppLogRuntimeOperations> {
  const start = processTransport.start
    ? available
    : ({
        available: false,
        reason: 'owner-capability-missing',
        hint: 'The selected Android transport cannot start a background adb logcat stream.',
      } as const);
  return Object.freeze({
    device: {
      family: 'android',
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

async function doctorAndroidAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  appBundleId: string | undefined,
  signal: AbortSignal,
) {
  const checks: Record<string, boolean> = {};
  checks.adbAvailable = await bestEffortAppLogCheck(
    async () =>
      appLogCommandSucceeded(
        await host.commands.run(
          {
            executable: 'adb',
            args: ['-s', device.id, 'shell', 'echo', 'ok'],
            allowFailure: true,
            timeoutMs: 1_000,
          },
          signal,
        ),
      ),
    signal,
  );
  if (appBundleId) {
    checks.androidPidVisible = await bestEffortAppLogCheck(
      async () =>
        Boolean(
          await resolveFirstNumericAppLogPid(
            host,
            androidPidRequest(device.id, appBundleId),
            signal,
          ),
        ),
      signal,
    );
  }
  return {
    backend: 'android' as const,
    checks,
    notes: appBundleId
      ? []
      : ['No app bundle is tracked in this session. Run open <app> first for app-scoped logs.'],
  };
}

async function startAndroidAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  input: AppLogStartInput,
  signal: AbortSignal,
  processTransport: AppLogProcessTransport,
): Promise<AppLogStartResult> {
  if (!processTransport.start) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The selected Android transport cannot start a background adb logcat stream.',
    );
  }
  assertAndroidLogPackageSafe(input.appBundleId);
  assertAppLogSessionArtifacts(host, input);
  if (!input.pidPath) {
    throw new AppError('INVALID_ARGS', 'Android app logs require a managed process marker');
  }
  const markerPath = input.pidPath;
  const handle = await createPidScopedAppLogProcess({
    host,
    backend: 'android',
    outputPath: input.outputPath,
    pidPath: markerPath,
    processStart: processTransport.start,
    setupSignal: signal,
    resolvePid: async (pidSignal) =>
      await resolveFirstNumericAppLogPid(
        host,
        androidPidRequest(device.id, input.appBundleId),
        pidSignal,
      ),
    command: (pid) => ({
      executable: 'adb',
      args: ['-s', device.id, 'logcat', '-v', 'time', '--pid', pid],
      allowFailure: true,
    }),
    cleanupFailureMessage: 'Android app-log cleanup did not settle every owned resource',
  });
  const descriptor: AndroidAppLogDescriptor = {
    transport:
      processTransport.mode === 'transport-composed'
        ? 'android-logcat-transport-composed'
        : 'android-logcat-local',
    outputPath: input.outputPath,
    pidPath: markerPath,
  };
  return createAppLogStartResult(
    handle,
    createAndroidAppLogEnvelope({
      sessionId: input.sessionId,
      device,
      owner,
      fence: input.fence,
      descriptor,
    }),
  );
}

function androidPidRequest(deviceId: string, appBundleId: string) {
  return {
    executable: 'adb',
    args: ['-s', deviceId, 'shell', 'pidof', appBundleId],
    allowFailure: true,
    timeoutMs: 5_000,
  } as const;
}
