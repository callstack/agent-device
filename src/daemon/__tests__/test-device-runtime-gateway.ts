import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import {
  createRequestHandler as createProductionRequestHandler,
  type RequestRouterDeps,
} from '../request-router.ts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../request-runtime-binding.ts';

export const unavailableDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    bind: async ({ device }) => ({
      device,
      owner: localRuntimeOwner(device.platform),
      facts: {
        device: {
          family: device.platform,
          kind: device.kind,
          providerMode: 'local',
          ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
          ...(device.target === undefined ? {} : { target: device.target }),
          ...(device.iosPhysicalDeviceBackend === undefined
            ? {}
            : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
        },
        operations: {
          appLogInspect: unavailable,
          appLogDoctor: unavailable,
          appLogStart: unavailable,
          appLogReattach: unavailable,
          appLogCleanup: unavailable,
          networkDump: unavailable,
          screenRecordingStart: unavailable,
          screenRecordingReattach: unavailable,
          screenRecordingCleanup: unavailable,
        },
      },
      operations: {},
      [Symbol.asyncDispose]: async () => {},
    }),
    shutdown: async () => {},
  });

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

export const unavailableBindDevice: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(
    await unavailableDeviceRuntimeGateway.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    }),
    use,
  );

export const unavailableBindExactDevice: BindExactDeviceRuntime = async (
  device,
  owner,
  fence,
  use,
  scope,
) =>
  narrowDeviceBinding(
    await unavailableDeviceRuntimeGateway.bind({
      device,
      intent: { kind: 'exact-owner', owner, fence },
      scope,
    }),
    use,
  );

export function createRequestHandler(
  deps: Omit<RequestRouterDeps, 'deviceRuntimeGateway'> &
    Partial<Pick<RequestRouterDeps, 'deviceRuntimeGateway'>>,
) {
  const { deviceRuntimeGateway = unavailableDeviceRuntimeGateway, ...rest } = deps;
  return createProductionRequestHandler({ ...rest, deviceRuntimeGateway });
}
