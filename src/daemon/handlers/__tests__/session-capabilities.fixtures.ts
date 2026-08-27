import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeProviderMode,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { HOVER_UNAVAILABLE_HINT } from '@agent-device/contracts/touch-runtime';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import {
  createUnavailableRuntimeFactsForTest,
  unavailableApplicationLifecycleOperationFacts,
} from '../../../__tests__/test-utils/runtime-operation-facts.ts';

const nativeRefUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);

export type CapabilitiesAdmissionRuntimeOptions = Readonly<{
  appLogAvailable: boolean;
  networkAvailable: boolean;
  appsAvailable?: boolean;
  providerMode: RuntimeProviderMode;
  deployAvailable?: boolean;
  sourceAvailable?: boolean;
  pushAvailable?: boolean;
  readinessAvailable?: boolean;
  /**
   * `screenshot` is fact-owned since R39, so the capabilities projection reads this cell instead
   * of a capability bucket. Defaults to available, matching every device the bucket used to admit.
   */
  screenshotAvailable?: boolean;
}>;

export function createCapabilitiesAdmissionRuntime(options: CapabilitiesAdmissionRuntimeOptions) {
  const uses: Array<{
    required: readonly string[];
    preferred: readonly string[];
    conditional?: readonly string[];
  }> = [];
  const inspections: DeviceInfo[] = [];
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    uses.push({
      required: [...use.required],
      preferred: [...use.preferred],
      ...(use.conditional === undefined ? {} : { conditional: [...use.conditional] }),
    });
    return narrowDeviceBinding(createAdmissionBinding(device, options), use);
  };
  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => {
    inspections.push(device);
    return createAdmissionFacts(device, options);
  };
  return { bindDevice, inspectFacts, inspections, uses };
}

function createAdmissionFacts(
  device: DeviceInfo,
  options: CapabilitiesAdmissionRuntimeOptions,
): RuntimeFacts<PlatformRuntimeOperations> {
  const unavailable = unavailableOperationFact(options.providerMode);
  const available = { available: true } as const;
  /** Every option-driven cell reads the same way: opted in means available for this fake owner. */
  const cell = (enabled: boolean | undefined) => (enabled ? available : unavailable);
  const appsFact = cell(options.appsAvailable);
  const screenshotFact = cell(options.screenshotAvailable !== false);
  const base = createUnavailableRuntimeFactsForTest(
    device,
    runtimeOwnerFor(device, options.providerMode),
    unavailable,
  );
  return {
    device: { ...base.device, providerMode: options.providerMode },
    operations: {
      ...base.operations,
      // Ref support is a native-owner capability, independent of provider transport support.
      tapRef: nativeRefUnavailable,
      hoverRef: Object.freeze({ ...nativeRefUnavailable, hint: HOVER_UNAVAILABLE_HINT }),
      fillRef: nativeRefUnavailable,
      // This fake historically keeps lifecycle ownership local and independently fail-closed.
      ...unavailableApplicationLifecycleOperationFacts,
      appLogInspect: cell(options.appLogAvailable),
      captureScreenshot: screenshotFact,
      deployApp: cell(options.deployAvailable),
      materializeAppSource: cell(options.sourceAvailable),
      deployMaterializedApp: cell(options.sourceAvailable),
      sendPushNotification: cell(options.pushAvailable),
      networkDump: cell(options.networkAvailable),
      ensureReady: options.readinessAvailable ? available : appsFact,
      listApps: appsFact,
    },
  };
}

function createAdmissionBinding(
  device: DeviceInfo,
  options: CapabilitiesAdmissionRuntimeOptions,
): DeviceBinding<PlatformRuntimeOperations> {
  return {
    device,
    owner: runtimeOwnerFor(device, options.providerMode),
    facts: createAdmissionFacts(device, options),
    operations: {
      ...(options.appLogAvailable ? { appLogInspect: inspectAndroidAppLog } : {}),
      ...(options.networkAvailable ? { networkDump: dumpEmptyAndroidNetwork } : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

function runtimeOwnerFor(device: DeviceInfo, providerMode: RuntimeProviderMode) {
  return providerMode === 'provider-runtime'
    ? providerRuntimeOwner('test', 'capabilities')
    : localRuntimeOwner(device.platform);
}

function unavailableOperationFact(providerMode: RuntimeProviderMode) {
  return {
    available: false as const,
    reason:
      providerMode === 'provider-runtime'
        ? ('unsupported-provider-mode' as const)
        : ('owner-capability-missing' as const),
  };
}

const inspectAndroidAppLog: PlatformRuntimeOperations['appLogInspect'] = async () => ({
  backend: 'android',
});

const dumpEmptyAndroidNetwork: PlatformRuntimeOperations['networkDump'] = async (input) => ({
  source: 'app-log',
  backend: 'android',
  dump: {
    path: '/tmp/app.log',
    exists: false,
    scannedLines: 0,
    matchedLines: 0,
    entries: [],
    include: input.include,
    limits: {
      maxEntries: input.maxEntries,
      maxPayloadChars: input.maxPayloadChars,
      maxScanLines: input.maxScanLines,
    },
  },
  notes: [],
});
