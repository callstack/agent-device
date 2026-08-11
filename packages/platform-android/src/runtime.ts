import type {
  DeviceBinding,
  NetworkDumpInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  EnsureReadyInput,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidAppLogRuntime } from './logs/runtime.ts';
import { dumpAndroidNetworkTraffic } from './network/runtime.ts';
import { bindAndroidScreenRecordingRuntime } from './recording/runtime.ts';
import { ensureAndroidReady } from './readiness/runtime.ts';

const owner = localRuntimeOwner('android');
const available = Object.freeze({ available: true } as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Headless boot is supported only for Android emulators.',
} as const);

export function createAndroidPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createAndroidAppLogRuntime(host);
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        networkDump: available,
        screenRecordingStart: available,
        screenRecordingReattach: available,
        screenRecordingCleanup: available,
        ensureReady: available,
        bootTarget: available,
        bootTargetHeadless: device.kind === 'emulator' ? available : headlessUnavailable,
        listApps: available,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'android',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recording = await bindAndroidScreenRecordingRuntime({
        host,
        device: request.device,
        owner,
        signal: request.scope.signal,
      });
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          networkDump: async (input: NetworkDumpInput) =>
            await dumpAndroidNetworkTraffic(host, request.device, input, request.scope.signal),
          ...recording,
          ensureReady: async (input: EnsureReadyInput) =>
            await ensureAndroidReady(
              host,
              request.device,
              { ...input, headless: false },
              request.scope.signal,
            ),
          bootTarget: async (input: EnsureReadyInput) =>
            await ensureAndroidReady(
              host,
              request.device,
              { ...input, headless: false },
              request.scope.signal,
            ),
          ...(facts.operations.bootTargetHeadless.available
            ? {
                bootTargetHeadless: async (input: EnsureReadyInput) =>
                  await ensureAndroidReady(
                    host,
                    request.device,
                    { ...input, headless: true },
                    request.scope.signal,
                  ),
              }
            : {}),
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.android.listApps(
              input.device,
              input.filter,
              request.scope.signal,
            ),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
