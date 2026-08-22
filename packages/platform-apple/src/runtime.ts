import type {
  DeviceBinding,
  NetworkDumpInput,
  RuntimeOperationFact,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindElementTextRuntime,
  elementTextRuntimeOperationFacts,
} from '@agent-device/contracts/element-text-runtime';
import {
  bindLocalFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  bindLocalScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import {
  bindLocalTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
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
import { appleNavigationFacts, createAppleNavigationOperations } from './navigation/runtime.ts';
import {
  bindAppleFindSelectorRuntime,
  bindAppleFindTextRuntime,
  bindAppleSnapshotRuntime,
} from './runtime-snapshot.ts';

const owner = localRuntimeOwner('apple');
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'viewport resizes web targets only (--platform web). Apple screen geometry is fixed by the selected simulator or device type — open a different simulator to test another screen size.',
} as const);
/**
 * Focus drives touch through the Apple interactor, which exists for the simulator and physical
 * device kinds only. Parity with the retired `focus` capability bucket
 * (`{ simulator: true, device: true }`), stated as one fact instead of an admission table.
 */
const focusKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'focus is supported on Apple simulators and physical devices.',
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
const elementTextLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'watchOS has no XCUITest-driveable UI, so element text comes from the captured tree only.',
} as const);
const elementTextKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
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
const screenshotWatchOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'screenshot is not supported on watchOS because XCUITest cannot drive watchOS UI.',
} as const);
const screenshotKindUnavailable = unsupportedAppleDeviceKind(
  'screenshot is supported only for Apple simulators and devices.',
);
const snapshotActiveAppRequired = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'Open the app under test before capturing its snapshot.',
} as const);
const nativeSelectorUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Native selector observation is available only on the Apple touch family.',
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

function appleFocusFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind === 'simulator' || device.kind === 'device' ? available : focusKindUnavailable;
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
        ...screenshotRuntimeOperationFacts({ capture: appleScreenshotFact(device) }),
        ...selectorObservationRuntimeOperationFacts({
          findText: appleSnapshotFact(device),
          findSelector: appleFindSelectorFact(device),
        }),
        ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
        ...focusRuntimeOperationFacts({ focus: appleFocusFact(device) }),
        // Text entry rides the same interactor authority the point focus does, so it shares the
        // exact kind cell (parity with the retired `type` bucket, `{ simulator, device }`).
        ...typeTextRuntimeOperationFacts({ type: appleFocusFact(device) }),
        ...elementTextRuntimeOperationFacts({ readTextAtPoint: appleElementTextFact(device) }),
        ...appleNavigationFacts(device),
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
      const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = {
        ...logs.operations,
        ...createAppleAppDeploymentOperations({
          host,
          device: request.device,
          signal: request.scope.signal,
        }),
        networkDump: async (input: NetworkDumpInput) =>
          await dumpAppleNetworkTraffic(host, request.device, input, request.scope.signal),
        ...whenAdmitted(recordingFacts, () =>
          createAppleScreenRecordingOperations({
            host,
            device: request.device,
            owner,
            signal: request.scope.signal,
          }),
        ),
        ...whenAdmitted(facts.operations.captureSnapshot, () =>
          bindAppleSnapshotRuntime(host, {
            device: request.device,
            signal: request.scope.signal,
          }),
        ),
        ...whenAdmitted(facts.operations.captureScreenshot, () =>
          bindLocalScreenshotInteractor({
            device: request.device,
            signal: request.scope.signal,
            resolveInteractor: host.localInteractors.resolve,
          }),
        ),
        ...whenAdmitted(facts.operations.focusPoint, () =>
          bindLocalFocusInteractor({
            device: request.device,
            signal: request.scope.signal,
            resolveInteractor: host.localInteractors.resolve,
          }),
        ),
        ...whenAdmitted(facts.operations.typeText, () =>
          bindLocalTypeTextInteractor({
            device: request.device,
            signal: request.scope.signal,
            resolveInteractor: host.localInteractors.resolve,
          }),
        ),
        ...whenAdmitted(facts.operations.readTextAtPoint, () =>
          bindElementTextRuntime({
            device: request.device,
            signal: request.scope.signal,
            resolveInteractor: host.localInteractors.resolve,
          }),
        ),
        ...whenAdmitted(facts.operations.findText, () =>
          bindAppleFindTextRuntime(host, {
            device: request.device,
            signal: request.scope.signal,
          }),
        ),
        ...whenAdmitted(facts.operations.findSelector, () =>
          bindAppleFindSelectorRuntime(host, {
            device: request.device,
            signal: request.scope.signal,
          }),
        ),
        ...createAppleNavigationOperations({
          host,
          device: request.device,
          signal: request.scope.signal,
        }),
        ...whenAdmitted(facts.operations.ensureReady, () => ({
          ensureReady: async () =>
            await ensureAppleReady(host, request.device, request.scope.signal),
        })),
        ...whenAdmitted(facts.operations.bootTarget, () => ({
          bootTarget: async () =>
            await ensureAppleReady(host, request.device, request.scope.signal),
        })),
        ...whenAdmitted(facts.operations.listApps, () => ({
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.apple.listApps(
              input.device,
              input.filter,
              request.scope.signal,
            ),
        })),
        ...availableApplicationLifecycleOperations(
          bindAppleApplicationLifecycle({
            host,
            device: request.device,
            signal: request.scope.signal,
          }),
          facts.operations,
        ),
        ...whenAdmitted(facts.operations.shutdownTarget, () => ({
          shutdownTarget: async () =>
            await host.deviceShutdown.apple.shutdownTarget(request.device, request.scope.signal),
        })),
      };
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze(operations),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}

/**
 * The live point read is the XCUITest runner's `readText` for app sessions and the macOS helper
 * for desktop/menubar surfaces. Both need a driveable Apple UI, so watchOS and the non
 * simulator/device kinds have no read at all.
 */
function appleElementTextFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return elementTextLeafUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : elementTextKindUnavailable;
}

function appleSnapshotFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return snapshotKindUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : snapshotKindUnavailable;
}

function appleFindSelectorFact(device: DeviceInfo) {
  return isIosFamily(device) ? appleSnapshotFact(device) : nativeSelectorUnavailable;
}

/**
 * macOS surface selection (app window vs desktop/menubar) lives inside the Apple interactor's own
 * capture, so the ordinary local interactor binding covers every admitted Apple cell — unlike
 * snapshot, whose desktop surfaces come from a separate host port.
 */
function appleScreenshotFact(device: DeviceInfo) {
  if (resolveDeviceAppleOs(device) === 'watchos') return screenshotWatchOsUnavailable;
  return device.kind === 'simulator' || device.kind === 'device'
    ? available
    : screenshotKindUnavailable;
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

/**
 * An operation is present on a binding only when the owner's own facts admitted it. One helper so
 * the binding below reads as a list of admitted operations rather than a chain of branches — and
 * so the next operation added here costs no additional complexity.
 */
function whenAdmitted<T extends object>(
  fact: RuntimeOperationFact,
  build: () => T,
): T | Record<string, never> {
  return fact.available ? build() : {};
}
