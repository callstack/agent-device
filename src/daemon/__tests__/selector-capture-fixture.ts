import {
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  type CaptureSnapshotInput,
  type SnapshotResult,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

const available: RuntimeOperationFact = Object.freeze({ available: true });

/**
 * The request-bound capture seam every selector command (`find`, `get`, `is`, `wait`)
 * consumes, faked at `inspectFacts` / `bindDevice` rather than at the legacy leaf
 * dispatch. Records each bind and each capture so a test can assert the ADR 0019 §9
 * shape directly: one inspection, one bind, and every capture through the bound
 * operation.
 */
export function selectorCaptureFixture(
  params: Readonly<{
    capture?: RuntimeOperationFact;
    withoutActiveApp?: RuntimeOperationFact;
    findText?: RuntimeOperationFact;
    snapshot?: (input: CaptureSnapshotInput, index: number) => SnapshotResult;
  }> = {},
): Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  inspections: DeviceInfo[];
  binds: DeviceInfo[];
  captures: CaptureSnapshotInput[];
}> {
  const inspections: DeviceInfo[] = [];
  const binds: DeviceInfo[] = [];
  const captures: CaptureSnapshotInput[] = [];

  const facts = async (device: DeviceInfo): Promise<RuntimeFacts<PlatformRuntimeOperations>> => {
    const base = await unavailableDeviceRuntimeGateway.inspectFacts(device);
    return {
      device: {
        ...deviceShape(device),
        providerMode: isActiveProviderDevice(device) ? 'provider-runtime' : 'local',
      },
      operations: {
        ...base.operations,
        ...snapshotRuntimeOperationFacts({
          capture: params.capture ?? available,
          customActions: { available: false, reason: 'unsupported-platform-leaf' },
          withoutActiveApp: params.withoutActiveApp ?? params.capture ?? available,
        }),
        ...(params.findText ? { findText: params.findText } : {}),
      },
    };
  };

  const captureSnapshot = async (input: CaptureSnapshotInput): Promise<SnapshotResult> => {
    const index = captures.length;
    captures.push(input);
    return (
      params.snapshot?.(input, index) ?? { nodes: [], backend: 'xctest', producer: 'apple-runner' }
    );
  };

  return {
    inspectFacts: async (device) => {
      inspections.push(device);
      return await facts(device);
    },
    bindDevice: async (device, use) => {
      binds.push(device);
      const deviceFacts = await facts(device);
      return narrowDeviceBinding(
        {
          device,
          owner:
            deviceFacts.device.providerMode === 'provider-runtime'
              ? providerRuntimeOwner('test', 'selector-capture-fixture')
              : localRuntimeOwner(device.platform),
          facts: deviceFacts,
          operations: {
            captureSnapshot,
            captureSnapshotWithCustomActions: captureSnapshot,
            captureSnapshotWithoutActiveApp: captureSnapshot,
          },
          [Symbol.asyncDispose]: async () => {},
        },
        use,
      );
    },
    inspections,
    binds,
    captures,
  };
}
