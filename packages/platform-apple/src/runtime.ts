import type {
  DeviceBinding,
  NetworkDumpInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  localRuntimeOwner,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/platform';
import {
  isIosFamily,
  isMacOs,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { createAppleAppLogRuntime } from './logs/runtime.ts';
import { dumpAppleNetworkTraffic } from './network/runtime.ts';
import {
  appleScreenRecordingFacts,
  createAppleScreenRecordingOperations,
} from './recording/runtime.ts';
import { ensureAppleReady } from './readiness/runtime.ts';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import {
  appleAppDeploymentFacts,
  createAppleAppDeploymentOperations,
} from './deployment/runtime.ts';
import { bindAppleSnapshotRuntime } from './runtime-snapshot.ts';

const owner = localRuntimeOwner('apple');
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple appstate reads the active session state; a sessionless runtime foreground probe is unavailable.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is supported only for local Android emulators.',
} as const);
const watchOpenTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'watchOS open is not supported because XCUITest cannot drive watchOS UI.',
} as const);
const watchPrepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'watchOS runner preparation is not supported because XCUITest cannot drive watchOS UI.',
} as const);
const watchCloseTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'watchOS close is not supported because XCUITest cannot drive watchOS UI.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Runtime hints are supported only for local iOS-family simulators and Android devices.',
} as const);

const appleOpenTargetKindUnavailable = unsupportedAppleDeviceKind(
  'open is supported only for Apple simulators and devices.',
);
const applePrepareKindUnavailable = unsupportedAppleDeviceKind(
  'prepare is supported only for Apple simulators and devices.',
);
const appleCloseTargetKindUnavailable = unsupportedAppleDeviceKind(
  'close is supported only for Apple simulators and devices.',
);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Port reverse is supported only by an owning provider runtime.',
} as const);
const shutdownKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'shutdown is supported only for Apple simulators and Android emulators.',
} as const);
const snapshotKindUnavailable = unsupportedAppleDeviceKind(
  'snapshot is supported only for Apple simulators and devices.',
);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Re-run without --actions, or target an iOS simulator.',
} as const);
const snapshotActiveAppRequired = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'Open the app under test before capturing its snapshot.',
} as const);

function unsupportedAppleDeviceKind(hint: string) {
  return Object.freeze({ available: false, reason: 'unsupported-device-kind', hint } as const);
}

function shutdownFact(device: DeviceInfo) {
  if (!isIosFamily(device) || device.appleOs === 'watchos') return unavailable;
  return device.kind === 'simulator' ? available : shutdownKindUnavailable;
}

function appleApplicationLifecycleFacts(device: DeviceInfo) {
  const openTarget = appleOpenTargetFact(device);
  const prepareAppleRunner = applePrepareAppleRunnerFact(device);
  const closeTarget = appleCloseTargetFact(device);
  const runtimeHints = appleRuntimeHintsFact(device);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: runtimeHints,
    clearRuntimeHints: runtimeHints,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

function appleOpenTargetFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return watchOpenTargetUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : appleOpenTargetKindUnavailable;
}

function applePrepareAppleRunnerFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return watchPrepareUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : applePrepareKindUnavailable;
}

function appleCloseTargetFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return watchCloseTargetUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : appleCloseTargetKindUnavailable;
}

function appleRuntimeHintsFact(device: DeviceInfo) {
  return resolveDeviceAppleOs(device) !== 'watchos' &&
    isIosFamily(device) &&
    device.kind === 'simulator'
    ? available
    : runtimeHintsUnavailable;
}

function appInventoryFacts(device: DeviceInfo) {
  if (device.appleOs === 'watchos') {
    return Object.freeze({
      available: false,
      reason: 'unsupported-platform-leaf' as const,
      hint: 'watchOS app inventory is not supported.',
    });
  }
  if (device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest') {
    return Object.freeze({
      available: false,
      reason: 'unsupported-device-backend' as const,
      hint: 'App inventory is available only on CoreDevice-backed physical iOS devices.',
    });
  }
  return available;
}

export function createApplePlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createAppleAppLogRuntime(host);
  const inspectFacts = async (device: DeviceInfo) => {
    const logs = await appLogs.inspectFacts(device);
    const deployment = appleAppDeploymentFacts(device);
    const leafRecordingFacts = appleScreenRecordingFacts(device);
    const hostAvailability = leafRecordingFacts.available
      ? await host.screenRecording.apple.availability(device)
      : undefined;
    const recordingFacts =
      leafRecordingFacts.available && hostAvailability?.available === false
        ? Object.freeze({
            available: false,
            reason: 'unsupported-provider-mode' as const,
            hint: hostAvailability.hint,
          })
        : leafRecordingFacts;
    const readiness = device.appleOs === 'watchos' ? unavailable : available;
    const boot = isMacOs(device) || device.appleOs === 'watchos' ? unavailable : available;
    const apps = appInventoryFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        ...deployment,
        appState: appStateUnavailable,
        networkDump: available,
        screenRecordingStart: recordingFacts,
        screenRecordingReattach: recordingFacts,
        screenRecordingCleanup: recordingFacts,
        ...appleSnapshotFacts(device),
        ensureReady: readiness,
        bootTarget: boot,
        bootTargetHeadless: headlessUnavailable,
        listApps: apps,
        ...appleApplicationLifecycleFacts(device),
        shutdownTarget: shutdownFact(device),
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'apple',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recordingFacts = facts.operations.screenRecordingStart;
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          ...createAppleAppDeploymentOperations({
            host,
            device: request.device,
            signal: request.scope.signal,
          }),
          networkDump: async (input: NetworkDumpInput) =>
            await dumpAppleNetworkTraffic(host, request.device, input, request.scope.signal),
          ...(recordingFacts.available
            ? createAppleScreenRecordingOperations({
                host,
                device: request.device,
                owner,
                signal: request.scope.signal,
              })
            : {}),
          ...(facts.operations.captureSnapshot.available
            ? bindAppleSnapshotRuntime(host, {
                device: request.device,
                signal: request.scope.signal,
              })
            : {}),
          ...(facts.operations.ensureReady.available
            ? {
                ensureReady: async () =>
                  await ensureAppleReady(host, request.device, request.scope.signal),
              }
            : {}),
          ...(facts.operations.bootTarget.available
            ? {
                bootTarget: async () =>
                  await ensureAppleReady(host, request.device, request.scope.signal),
              }
            : {}),
          ...(facts.operations.listApps.available
            ? {
                listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
                  await host.appInventory.apple.listApps(
                    input.device,
                    input.filter,
                    request.scope.signal,
                  ),
              }
            : {}),
          ...availableApplicationLifecycleOperations(
            bindAppleApplicationLifecycle({
              host,
              device: request.device,
              signal: request.scope.signal,
            }),
            facts.operations,
          ),
          ...(facts.operations.shutdownTarget.available
            ? {
                shutdownTarget: async () =>
                  await host.deviceShutdown.apple.shutdownTarget(
                    request.device,
                    request.scope.signal,
                  ),
              }
            : {}),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}

function appleSnapshotFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return snapshotKindUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : snapshotKindUnavailable;
}

function appleSnapshotFacts(device: DeviceInfo) {
  const capture = appleSnapshotFact(device);
  return snapshotRuntimeOperationFacts({
    capture,
    customActions:
      capture.available && isIosFamily(device) && device.kind === 'simulator'
        ? available
        : snapshotCustomActionsUnavailable,
    withoutActiveApp: isIosFamily(device) ? snapshotActiveAppRequired : capture,
  });
}
