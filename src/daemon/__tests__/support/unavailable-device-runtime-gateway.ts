import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit/runtime-operation-facts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../../request-runtime-binding.ts';

/**
 * The `DeviceRuntimeGateway` port answering that no owner on this host can bind the device:
 * every operation fact unavailable, no operations, nothing to dispose.
 */
export const unavailableDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    inspectFacts: async (device) => (await unavailableBinding(device)).facts,
    bind: async ({ device }) => {
      const owner = localRuntimeOwner(device.platform);
      return {
        device,
        owner,
        facts: createUnavailableRuntimeFactsForTest(device, owner),
        operations: {},
        [Symbol.asyncDispose]: async () => {},
      };
    },
    shutdown: async () => {},
  });

export async function unavailableBinding(device: DeviceInfo) {
  return await unavailableDeviceRuntimeGateway.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
}

export const unavailableBindDevice: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(await unavailableBinding(device), use);

export const unavailableInspectFacts = unavailableDeviceRuntimeGateway.inspectFacts;

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
