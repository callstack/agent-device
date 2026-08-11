import { vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type NetworkDumpInput,
  type NetworkDumpResult,
  type PlatformRuntimeOperations,
  type RuntimeOperationFact,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';

export function createNetworkRuntime(
  device: DeviceInfo,
  implementation: (input: NetworkDumpInput) => Promise<NetworkDumpResult>,
  networkFact: RuntimeOperationFact = { available: true },
  owner: RuntimeOwnerRef = localRuntimeOwner(device.platform),
) {
  const uses: Array<{ required: readonly string[]; preferred: readonly string[] }> = [];
  const networkDump = vi.fn(implementation);
  const unavailable = {
    available: false,
    reason: 'owner-capability-missing',
  } as const;
  const bindDevice: BindDeviceRuntime = async (selected, use) => {
    uses.push({ required: [...use.required], preferred: [...use.preferred] });
    return narrowDeviceBinding(
      {
        device: selected,
        owner,
        facts: {
          device: {
            family: selected.platform,
            ...(selected.appleOs === undefined ? {} : { appleOs: selected.appleOs }),
            kind: selected.kind,
            ...(selected.target === undefined ? {} : { target: selected.target }),
            ...(selected.iosPhysicalDeviceBackend === undefined
              ? {}
              : { iosPhysicalDeviceBackend: selected.iosPhysicalDeviceBackend }),
            providerMode: owner.kind === 'provider-runtime' ? 'provider-runtime' : 'local',
          },
          operations: {
            appLogInspect: unavailable,
            appLogDoctor: unavailable,
            appLogStart: unavailable,
            appLogReattach: unavailable,
            appLogCleanup: unavailable,
            networkDump: networkFact,
            screenRecordingStart: unavailable,
            screenRecordingReattach: unavailable,
            screenRecordingCleanup: unavailable,
            ensureReady: unavailable,
            bootTarget: unavailable,
            bootTargetHeadless: unavailable,
            listApps: unavailable,
          },
        },
        operations: networkFact.available ? { networkDump } : {},
        [Symbol.asyncDispose]: async () => {},
      } satisfies import('@agent-device/contracts/platform').DeviceBinding<PlatformRuntimeOperations>,
      use,
    );
  };
  return { bindDevice, networkDump, uses };
}

export function emptyAppLogResult(
  backend: 'android' | 'harmonyos',
  input?: NetworkDumpInput,
): Extract<NetworkDumpResult, { source: 'app-log' }> {
  return {
    source: 'app-log',
    backend,
    dump: {
      path: '/sessions/app.log',
      exists: false,
      scannedLines: 0,
      matchedLines: 0,
      entries: [],
      include: input?.include ?? 'summary',
      limits: {
        maxEntries: input?.maxEntries ?? 25,
        maxPayloadChars: input?.maxPayloadChars ?? 2048,
        maxScanLines: input?.maxScanLines ?? 4000,
      },
    },
    notes: [],
  };
}
