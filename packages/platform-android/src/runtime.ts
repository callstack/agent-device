import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import type { NetworkDumpInput } from '@agent-device/contracts/network-runtime';
import type { DeviceBinding, RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
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
import { localRuntimeOwner, whenAdmitted } from '@agent-device/contracts/platform-runtime';
import {
  bindLocalScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import {
  bindLocalSnapshotInteractor,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import {
  bindLocalTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import {
  bindLocalTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidAppLogRuntime } from './logs/runtime.ts';
import { dumpAndroidNetworkTraffic } from './network/runtime.ts';
import { bindAndroidScreenRecordingRuntime } from './recording/runtime.ts';
import { ensureAndroidReady } from './readiness/runtime.ts';
import { readAndroidAppState } from './app-state.ts';
import { bindAndroidApplicationLifecycle } from './lifecycle.ts';
import {
  androidAppDeploymentFacts,
  createAndroidAppDeploymentOperations,
} from './deployment/runtime.ts';

const owner = localRuntimeOwner('android');
const available = Object.freeze({ available: true } as const);
const elementTextKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
} as const);
/**
 * Parity with the retired `focus` capability bucket (`{ emulator, device, unknown }`): every
 * Android kind drives touch through adb except the synthetic `simulator` row, which has no device.
 */
const focusKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'focus is supported on Android emulators and physical devices.',
} as const);
const hoverUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Headless boot is supported only for Android emulators.',
} as const);
const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Android appstate is supported only for Android emulators and devices.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'open is supported only for Android emulators and devices.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'close is supported only for Android emulators and devices.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Runtime hints are supported only for Android emulators and devices.',
} as const);
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
const screenshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'screenshot is supported only for Android emulators and devices.',
} as const);
const snapshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'snapshot is supported only for Android emulators and devices.',
} as const);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Re-run without --actions, or target an iOS simulator.',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'viewport resizes web targets only (--platform web).',
} as const);

function androidLifecycleFacts(device: DeviceInfo) {
  const openTarget = androidOpenTargetFact(device);
  const closeTarget = androidCloseTargetFact(device);
  const runtimeHints = androidRuntimeHintsFact(device);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: runtimeHints,
    clearRuntimeHints: runtimeHints,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

function androidOpenTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device' ? available : openTargetUnavailable;
}

function androidCloseTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? available
    : closeTargetUnavailable;
}

function androidRuntimeHintsFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? available
    : runtimeHintsUnavailable;
}

/** adb drives every interaction cell the same way; only the synthetic `simulator` row lacks a device. */
function androidTouchFact(device: DeviceInfo) {
  return device.kind === 'simulator' ? focusKindUnavailable : available;
}

const tvRemoteUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'tv-remote is supported only on Android TV targets.',
} as const);
/**
 * Parity with the retired `androidPlugin` closure: the TV-target gate, whose hint fired
 * regardless of device kind (the closure never distinguished the synthetic `simulator` row from
 * a real non-TV device), so both refuse with the identical hint text.
 */
function androidTvRemoteFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind !== 'simulator' && device.target === 'tv' ? available : tvRemoteUnavailable;
}

export function createAndroidPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createAndroidAppLogRuntime(host);
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    const deployment = androidAppDeploymentFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        ...deployment,
        appState: device.kind === 'simulator' ? appStateUnavailable : available,
        networkDump: available,
        screenRecordingStart: available,
        screenRecordingReattach: available,
        screenRecordingCleanup: available,
        ...snapshotRuntimeOperationFacts({
          capture: device.kind === 'simulator' ? snapshotKindUnavailable : available,
          customActions: snapshotCustomActionsUnavailable,
          withoutActiveApp: device.kind === 'simulator' ? snapshotKindUnavailable : available,
        }),
        ...screenshotRuntimeOperationFacts({
          capture: device.kind === 'simulator' ? screenshotKindUnavailable : available,
        }),
        // No native text reading: every text wait on this owner polls the canonical tree.
        ...selectorObservationRuntimeOperationFacts({
          findText: snapshotKindUnavailable,
          findSelector: snapshotKindUnavailable,
        }),
        ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
        ...focusRuntimeOperationFacts({ focus: androidTouchFact(device) }),
        // Text entry shares focus's cell: adb drives both, and only the synthetic `simulator`
        // row has no device behind it (parity with the retired `type` bucket).
        ...typeTextRuntimeOperationFacts({ type: androidTouchFact(device) }),
        ...touchRuntimeOperationFacts({
          tap: androidTouchFact(device),
          tapRef: focusKindUnavailable,
          longPress: androidTouchFact(device),
          hover: hoverUnavailable,
          hoverRef: focusKindUnavailable,
          fill: androidTouchFact(device),
          fillRef: focusKindUnavailable,
          tapElementSelector: focusKindUnavailable,
        }),
        // uiautomator reads text at a point through the same adb path the snapshot uses, so the
        // synthetic `simulator` row is the only Android kind without a live read.
        ...elementTextRuntimeOperationFacts({
          readTextAtPoint: device.kind === 'simulator' ? elementTextKindUnavailable : available,
        }),
        ...backRuntimeOperationFacts({ back: androidTouchFact(device) }),
        ...homeRuntimeOperationFacts({ home: androidTouchFact(device) }),
        ...orientationRuntimeOperationFacts({ orientation: androidTouchFact(device) }),
        ...tvRemoteRuntimeOperationFacts({ tvRemote: androidTvRemoteFact(device) }),
        // The only owner with a live IME status read; dismiss/enter share every other
        // interaction cell's kind gate (parity with the retired `keyboard` bucket).
        ...keyboardRuntimeOperationFacts({
          status: androidTouchFact(device),
          dismiss: androidTouchFact(device),
          enter: androidTouchFact(device),
        }),
        ensureReady: available,
        bootTarget: available,
        bootTargetHeadless: device.kind === 'emulator' ? available : headlessUnavailable,
        listApps: available,
        ...androidLifecycleFacts(device),
        shutdownTarget: device.kind === 'emulator' ? available : shutdownKindUnavailable,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'android',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recording = await bindAndroidScreenRecordingRuntime({
        host,
        device: request.device,
        owner,
        signal: request.scope.signal,
      });
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          ...createAndroidAppDeploymentOperations({
            host,
            device: request.device,
            signal: request.scope.signal,
          }),
          ...(facts.operations.appState.available
            ? {
                appState: async () =>
                  await readAndroidAppState(
                    host.appState.android,
                    request.device,
                    request.scope.signal,
                  ),
              }
            : {}),
          networkDump: async (input: NetworkDumpInput) =>
            await dumpAndroidNetworkTraffic(host, request.device, input, request.scope.signal),
          ...recording,
          ...(facts.operations.captureSnapshot.available
            ? bindLocalSnapshotInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ...(facts.operations.captureScreenshot.available
            ? bindLocalScreenshotInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ...(facts.operations.focusPoint.available
            ? bindLocalFocusInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ...(facts.operations.typeText.available
            ? bindLocalTypeTextInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ...whenAdmitted(facts.operations.tapPoint, () =>
            bindLocalTouchInteractor({
              facts: facts.operations,
              device: request.device,
              signal: request.scope.signal,
              resolveInteractor: host.localInteractors.resolve,
              pause: async (milliseconds) =>
                await host.clock.sleep(milliseconds, request.scope.signal),
            }),
          ),
          ...(facts.operations.readTextAtPoint.available
            ? bindElementTextRuntime({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ...bindAdmittedLocalInteractorOperations({
            device: request.device,
            signal: request.scope.signal,
            resolveInteractor: host.localInteractors.resolve,
            facts: facts.operations,
          }),
          ensureReady: async (input: EnsureReadyInput) =>
            await ensureAndroidReady(
              host,
              request.device,
              { ...input, headless: false },
              request.scope.signal,
            ),
          bootTarget: async (input: EnsureReadyInput) =>
            await ensureAndroidReady(
              host,
              request.device,
              { ...input, headless: false },
              request.scope.signal,
            ),
          ...(facts.operations.bootTargetHeadless.available
            ? {
                bootTargetHeadless: async (input: EnsureReadyInput) =>
                  await ensureAndroidReady(
                    host,
                    request.device,
                    { ...input, headless: true },
                    request.scope.signal,
                  ),
              }
            : {}),
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.android.listApps(
              input.device,
              input.filter,
              request.scope.signal,
            ),
          ...availableApplicationLifecycleOperations(
            bindAndroidApplicationLifecycle({
              host,
              device: request.device,
              signal: request.scope.signal,
            }),
            facts.operations,
          ),
          ...(facts.operations.shutdownTarget.available
            ? {
                shutdownTarget: async () =>
                  await host.deviceShutdown.android.shutdownTarget(
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
