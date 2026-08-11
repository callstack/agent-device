import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyAppLogRuntime } from './logs/runtime.ts';
import {
  createHarmonyScreenRecordingOperations,
  harmonyScreenRecordingFacts,
} from './recording/runtime.ts';

const owner = localRuntimeOwner('harmonyos');
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createHarmonyPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createHarmonyAppLogRuntime(host);
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    const recordingFacts = harmonyScreenRecordingFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        networkDump: unavailable,
        screenRecordingStart: recordingFacts,
        screenRecordingReattach: recordingFacts,
        screenRecordingCleanup: recordingFacts,
        ensureReady: available,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: available,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'harmonyos',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recordingFacts = facts.operations.screenRecordingStart;
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          ...(recordingFacts.available
            ? createHarmonyScreenRecordingOperations({
                host,
                device: request.device,
                owner,
                signal: request.scope.signal,
              })
            : {}),
          ensureReady: async () => ({ ...request.device, booted: true }),
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.harmonyos.listApps(
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
