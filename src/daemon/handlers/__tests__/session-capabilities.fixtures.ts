import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  screenshotRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type RuntimeProviderMode,
} from '@agent-device/contracts/platform';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { unavailableApplicationLifecycleOperationFacts } from '../../../__tests__/test-utils/runtime-operation-facts.ts';

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

export const legacyCapabilityUses = [
  { required: [], preferred: ['appLogInspect'] },
  { required: [], preferred: ['networkDump'] },
  { required: [], preferred: ['screenRecordingStart'] },
];

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
  return {
    device: { ...deviceShape(device), providerMode: options.providerMode },
    operations: {
      ...unavailableApplicationLifecycleOperationFacts,
      appLogInspect: cell(options.appLogAvailable),
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: unavailable,
      ...snapshotRuntimeOperationFacts({
        capture: unavailable,
        customActions: unavailable,
        withoutActiveApp: unavailable,
      }),
      ...screenshotRuntimeOperationFacts({ capture: screenshotFact }),
      findText: unavailable,
      findSelector: unavailable,
      setViewport: unavailable,
      focusPoint: unavailable,
      typeText: unavailable,
      deployApp: cell(options.deployAvailable),
      materializeAppSource: cell(options.sourceAvailable),
      deployMaterializedApp: cell(options.sourceAvailable),
      sendPushNotification: cell(options.pushAvailable),
      networkDump: cell(options.networkAvailable),
      readTextAtPoint: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: options.readinessAvailable ? available : appsFact,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
      shutdownTarget: unavailable,
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
    owner:
      options.providerMode === 'provider-runtime'
        ? providerRuntimeOwner('test', 'capabilities')
        : localRuntimeOwner(device.platform),
    facts: createAdmissionFacts(device, options),
    operations: {
      ...(options.appLogAvailable ? { appLogInspect: inspectAndroidAppLog } : {}),
      ...(options.networkAvailable ? { networkDump: dumpEmptyAndroidNetwork } : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  };
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
