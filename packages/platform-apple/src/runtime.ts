import type {
  DeviceBinding,
  NetworkDumpInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createAppleAppLogRuntime } from './logs/runtime.ts';
import { dumpAppleNetworkTraffic } from './network/runtime.ts';

const owner = localRuntimeOwner('apple');
const available = Object.freeze({ available: true } as const);

export function createApplePlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createAppleAppLogRuntime(host);
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'apple',
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      return Object.freeze({
        device: logs.device,
        owner,
        facts: Object.freeze({
          device: logs.facts.device,
          operations: { ...logs.facts.operations, networkDump: available },
        }),
        operations: Object.freeze({
          ...logs.operations,
          networkDump: async (input: NetworkDumpInput) =>
            await dumpAppleNetworkTraffic(host, request.device, input, request.scope.signal),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
