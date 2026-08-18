import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import {
  applicationLifecycleOperationFacts,
  type ApplicationLifecycleOperationFacts,
} from './application-lifecycle-runtime.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import type {
  DeviceBinding,
  RuntimeFacts,
  RuntimeOperationUnavailability,
  RuntimeOwnerRef,
} from './platform-runtime.ts';
import { snapshotRuntimeOperationFacts } from './snapshot-runtime.ts';
import { viewportRuntimeOperationFacts } from './viewport-runtime.ts';

/**
 * A runtime-contract helper for provider ownership gaps. It never assigns lifecycle semantics:
 * the selected package/provider must classify every lifecycle operation for its exact cell.
 */
export type UnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  apps?: RuntimeOperationUnavailability;
  appDeployment?: RuntimeOperationUnavailability;
  appState?: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording?: RuntimeOperationUnavailability;
  snapshot?: RuntimeOperationUnavailability;
  viewport?: RuntimeOperationUnavailability;
  readiness?: RuntimeOperationUnavailability;
  shutdown?: RuntimeOperationUnavailability;
  lifecycle: ApplicationLifecycleOperationFacts;
}>;

type FrozenUnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  apps: RuntimeOperationUnavailability;
  appDeployment: RuntimeOperationUnavailability;
  appState: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording: RuntimeOperationUnavailability;
  snapshot: RuntimeOperationUnavailability;
  viewport: RuntimeOperationUnavailability;
  readiness: RuntimeOperationUnavailability;
  shutdown: RuntimeOperationUnavailability;
  lifecycle: ApplicationLifecycleOperationFacts;
}>;

export function createUnavailablePlatformRuntimeBinding(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): DeviceBinding<PlatformRuntimeOperations> {
  return Object.freeze({
    device,
    owner,
    facts: createUnavailablePlatformRuntimeFacts(device, owner, unavailable),
    operations: Object.freeze({}),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeFacts(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): RuntimeFacts<PlatformRuntimeOperations> {
  const {
    appLog,
    apps,
    appDeployment,
    appState,
    network,
    screenRecording,
    snapshot,
    viewport,
    readiness,
    shutdown,
    lifecycle,
  } = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: owner.kind === 'local-family' ? 'local' : 'provider-runtime',
    },
    operations: {
      appLogInspect: appLog,
      appLogDoctor: appLog,
      appLogStart: appLog,
      appLogReattach: appLog,
      appLogCleanup: appLog,
      listApps: apps,
      deployApp: appDeployment,
      materializeAppSource: appDeployment,
      deployMaterializedApp: appDeployment,
      sendPushNotification: appDeployment,
      appState,
      networkDump: network,
      screenRecordingStart: screenRecording,
      screenRecordingReattach: screenRecording,
      screenRecordingCleanup: screenRecording,
      ...snapshotRuntimeOperationFacts({
        capture: snapshot,
        customActions: snapshot,
        withoutActiveApp: snapshot,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: viewport }),
      ensureReady: readiness,
      bootTarget: readiness,
      bootTargetHeadless: readiness,
      shutdownTarget: shutdown,
      ...lifecycle,
    },
  });
}

function freezeUnavailableFacts(
  unavailable: UnavailablePlatformRuntimeFacts,
): FrozenUnavailablePlatformRuntimeFacts {
  return Object.freeze({
    appLog: Object.freeze({ ...unavailable.appLog }),
    apps: Object.freeze({ ...(unavailable.apps ?? unavailable.network) }),
    appDeployment: Object.freeze({ ...(unavailable.appDeployment ?? unavailable.network) }),
    appState: Object.freeze({ ...(unavailable.appState ?? unavailable.network) }),
    network: Object.freeze({ ...unavailable.network }),
    screenRecording: Object.freeze({
      ...(unavailable.screenRecording ?? unavailable.network),
    }),
    snapshot: Object.freeze({ ...(unavailable.snapshot ?? unavailable.network) }),
    viewport: Object.freeze({ ...(unavailable.viewport ?? unavailable.network) }),
    readiness: Object.freeze({ ...(unavailable.readiness ?? unavailable.network) }),
    shutdown: Object.freeze({ ...(unavailable.shutdown ?? unavailable.network) }),
    lifecycle: applicationLifecycleOperationFacts(unavailable.lifecycle),
  });
}
