import {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  type CaptureSnapshotInput,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type SnapshotResult,
} from '@agent-device/contracts/platform';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { dispatchCommand, type DispatchContext } from '../../core/dispatch.ts';
import { getRequestSignal } from '../../request/cancel.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

/** Request-scoped snapshot seam for handler tests that mock the legacy leaf dispatch. */
export function snapshotRuntimeFixture(requestId?: string): Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
}> {
  const requestSignal = getRequestSignal(requestId) ?? new AbortController().signal;

  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => await snapshotFacts(device);
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    const facts = await snapshotFacts(device);
    const providerOwned = facts.device.providerMode === 'provider-runtime';
    return narrowDeviceBinding(
      {
        device,
        owner: providerOwned
          ? providerRuntimeOwner('test', 'snapshot-runtime-fixture')
          : localRuntimeOwner(device.platform),
        facts,
        operations: {
          captureSnapshot: async (input) =>
            await dispatchFixtureSnapshot(device, input, requestSignal),
        },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );
  };

  return { inspectFacts, bindDevice };
}

async function snapshotFacts(device: DeviceInfo): Promise<RuntimeFacts<PlatformRuntimeOperations>> {
  const base = await unavailableDeviceRuntimeGateway.inspectFacts(device);
  return {
    device: {
      ...deviceShape(device),
      providerMode: isActiveProviderDevice(device) ? 'provider-runtime' : 'local',
    },
    operations: {
      ...base.operations,
      captureSnapshot: { available: true },
    },
  };
}

async function dispatchFixtureSnapshot(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
): Promise<SnapshotResult> {
  const options = input.options ?? {};
  const context: DispatchContext = {
    ...input.execution,
    signal,
    appBundleId: options.appBundleId,
    snapshotInteractiveOnly: options.interactiveOnly,
    snapshotPreferredBackend: options.preferredBackend,
    snapshotDepth: options.depth,
    snapshotScope: options.scope,
    snapshotRaw: options.raw,
    snapshotCustomActions: options.customActions,
    snapshotIncludeHiddenContentHints: options.includeHiddenContentHints,
    surface: options.surface,
  };
  return (await dispatchCommand(device, 'snapshot', [], undefined, context)) as SnapshotResult;
}
