import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createHarmonyAppLogRuntime } from './logs/runtime.ts';
import {
  createHarmonyScreenRecordingOperations,
  harmonyScreenRecordingFacts,
} from './recording/runtime.ts';

const owner = localRuntimeOwner('harmonyos');
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createHarmonyPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createHarmonyAppLogRuntime(host);
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'harmonyos',
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const recordingFacts = harmonyScreenRecordingFacts(request.device);
      return Object.freeze({
        device: logs.device,
        owner,
        facts: Object.freeze({
          device: logs.facts.device,
          operations: {
            ...logs.facts.operations,
            networkDump: unavailable,
            screenRecordingStart: recordingFacts,
            screenRecordingReattach: recordingFacts,
            screenRecordingCleanup: recordingFacts,
          },
        }),
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
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
