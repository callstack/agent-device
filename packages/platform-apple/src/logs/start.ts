import path from 'node:path';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AppLogBackgroundProcess,
  AppLogLiveSnapshot,
  AppLogRuntimeHost,
  AppLogStartInput,
  AppLogStartResult,
  FinishOutcome,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import type { LogBackend } from '@agent-device/contracts/observability';
import { AsyncCleanupStack } from '@agent-device/contracts/platform';
import {
  assertAppLogSessionArtifacts,
  createAppLogLiveHandleFromFinish,
  createAppLogStartResult,
} from '@agent-device/capture-kit';
import { APPLE_XCTEST_LOGS_HINT, backendForAppleDevice } from './backend.ts';
import {
  checkCoreDeviceConsoleCaptureSupport,
  IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED,
} from './coredevice-console.ts';
import { createAppleAppLogEnvelope, type AppleAppLogDescriptor } from './descriptor.ts';
import {
  buildAppleLogPredicate,
  buildIosDeviceConsoleLaunchArgs,
  buildIosSimulatorLogStreamArgs,
} from './log-predicate.ts';

export async function startAppleAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  input: AppLogStartInput,
  owner: RuntimeOwnerRef,
  signal?: AbortSignal,
): Promise<AppLogStartResult> {
  assertAppleLogStartSupported(device);
  assertAppLogSessionArtifacts(host, input);
  const backend = backendForAppleDevice(device);
  const command = await commandForAppleAppLogs(host, device, input.appBundleId, signal);
  const rollback = new AsyncCleanupStack();
  let adopted = false;
  try {
    const output = await host.outputs.openAppend(input.outputPath);
    rollback.defer(async () => {
      if (!adopted) await output[Symbol.asyncDispose]();
    });
    signal?.throwIfAborted();
    const backgroundProcess = await startCheckedAppleProcess(
      host,
      device,
      command,
      output,
      input.pidPath,
      signal,
    );
    rollback.defer(async () => {
      if (!adopted) await backgroundProcess[Symbol.asyncDispose]();
    });
    const handle = createAppleProcessHandle(
      host,
      backgroundProcess,
      output,
      backend,
      input.outputPath,
    );
    const descriptor: AppleAppLogDescriptor = {
      transport: backend === 'ios-device' ? 'coredevice-console' : 'apple-log-stream',
      backend,
      outputPath: input.outputPath,
      ...(input.pidPath === undefined ? {} : { pidPath: input.pidPath }),
    };
    const result = createAppLogStartResult(
      handle,
      createAppleAppLogEnvelope({
        sessionId: input.sessionId,
        device,
        owner,
        fence: input.fence,
        descriptor,
      }),
    );
    adopted = true;
    return result;
  } finally {
    await rollback[Symbol.asyncDispose]();
  }
}

function assertAppleLogStartSupported(device: DeviceInfo): void {
  if (device.appleOs === 'watchos') {
    throw new AppError('UNSUPPORTED_PLATFORM', 'watchOS app logs are not supported');
  }
  if (
    isIosFamily(device) &&
    device.kind === 'device' &&
    device.iosPhysicalDeviceBackend === 'xctest'
  ) {
    throw new AppError('UNSUPPORTED_OPERATION', APPLE_XCTEST_LOGS_HINT, {
      hint: APPLE_XCTEST_LOGS_HINT,
    });
  }
}

async function startCheckedAppleProcess(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  command: { executable: string; args: readonly string[]; allowFailure: true },
  output: Awaited<ReturnType<AppLogRuntimeHost['outputs']['openAppend']>>,
  pidPath: string | undefined,
  signal?: AbortSignal,
): Promise<AppLogBackgroundProcess> {
  if (isIosFamily(device) && device.kind === 'device') {
    const support = await checkCoreDeviceConsoleCaptureSupport(host, signal);
    if (!support.supported) {
      const message =
        support.reason === 'unsupported'
          ? IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED
          : IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED;
      throw new AppError(
        support.reason === 'unsupported' ? 'UNSUPPORTED_OPERATION' : 'COMMAND_FAILED',
        message.message,
        { backend: 'ios-device', hint: message.hint, stderr: support.stderr },
      );
    }
  }
  signal?.throwIfAborted();
  return await host.processes.start({
    command: { kind: 'host', request: command },
    output,
    ...(pidPath ? { markerPath: pidPath } : {}),
  });
}

async function commandForAppleAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  appBundleId: string,
  signal?: AbortSignal,
) {
  if (isMacOs(device)) {
    return {
      executable: 'log',
      args: ['stream', '--style', 'compact', '--predicate', buildAppleLogPredicate(appBundleId)],
      allowFailure: true,
    } as const;
  }
  if (device.kind === 'device') {
    return {
      executable: 'xcrun',
      args: buildIosDeviceConsoleLaunchArgs(device.id, appBundleId),
      allowFailure: true,
    } as const;
  }
  const executableName = await resolveSimulatorExecutable(host, device, appBundleId, signal);
  return {
    executable: 'xcrun',
    args: buildIosSimulatorLogStreamArgs({
      deviceId: device.id,
      appBundleId,
      executableName,
      simulatorSetPath: device.simulatorSetPath,
    }),
    allowFailure: true,
  } as const;
}

async function resolveSimulatorExecutable(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  appBundleId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const prefix = device.simulatorSetPath ? ['--set', device.simulatorSetPath] : [];
  const container = await host.appleTools.run(
    {
      tool: 'simctl',
      args: [...prefix, 'get_app_container', device.id, appBundleId, 'app'],
      allowFailure: true,
      timeoutMs: 4_000,
    },
    signal,
  );
  const appPath = container.exitCode === 0 ? container.stdout.trim() : '';
  if (!appPath) return undefined;
  const plist = await host.commands.run(
    {
      executable: 'plutil',
      args: ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(appPath, 'Info.plist')],
      allowFailure: true,
      timeoutMs: 4_000,
    },
    signal,
  );
  return plist.exitCode === 0 ? plist.stdout.trim() || undefined : undefined;
}

function createAppleProcessHandle(
  host: AppLogRuntimeHost,
  backgroundProcess: AppLogBackgroundProcess,
  output: Awaited<ReturnType<AppLogRuntimeHost['outputs']['openAppend']>>,
  backend: LogBackend,
  outputPath: string,
) {
  const startedAt = host.clock.now();
  let state: AppLogLiveSnapshot['state'] = 'active';
  void backgroundProcess.wait.then(
    (result) => {
      state = result.exitCode === 0 ? 'ended' : 'failed';
    },
    () => {
      state = 'failed';
    },
  );
  let finishPromise:
    | Promise<FinishOutcome<{ backend: LogBackend; outputPath: string; completedAt: number }>>
    | undefined;
  const finish = async () =>
    (finishPromise ??= (async () => {
      const failures = await cleanupInOrder([
        async () => await backgroundProcess.terminate(),
        async () => await backgroundProcess.wait.then(() => undefined),
        async () => await backgroundProcess[Symbol.asyncDispose](),
        async () => await output[Symbol.asyncDispose](),
      ]);
      if (failures.length > 0) {
        state = 'failed';
        return {
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: 'Apple app-log cleanup did not settle every owned resource',
        } as const;
      }
      state = 'ended';
      return {
        status: 'completed',
        result: { backend, outputPath, completedAt: host.clock.now() },
      } as const;
    })());
  return createAppLogLiveHandleFromFinish({
    inspect: () => ({ backend, state, startedAt }),
    finish,
  });
}

async function cleanupInOrder(steps: readonly (() => Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
