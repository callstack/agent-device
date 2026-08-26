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
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import {
  bindLocalFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT } from '@agent-device/contracts/gesture-admission';
import {
  bindLocalGestureInteractor,
  gestureRuntimeOperationFacts,
} from '@agent-device/contracts/gesture-runtime';
import {
  bindLocalScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { appSwitcherRuntimeOperationFacts } from '@agent-device/contracts/app-switcher-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { audioProbeRuntimeOperationFacts } from '@agent-device/contracts/audio-probe-runtime';
import { perfRuntimeOperationFacts } from '@agent-device/contracts/perf-runtime';
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
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import {
  bindLocalTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import {
  bindLocalTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyAppLogRuntime } from './logs/runtime.ts';
import { createHarmonyPerfOperations } from './perf/runtime.ts';
import {
  createHarmonyScreenRecordingOperations,
  harmonyScreenRecordingFacts,
} from './recording/runtime.ts';
import { readHarmonyAppState } from './app-state.ts';
import { bindHarmonyApplicationLifecycle } from './lifecycle.ts';
import {
  createHarmonyAppDeploymentOperations,
  harmonyAppDeploymentFacts,
} from './deployment/runtime.ts';

const owner = localRuntimeOwner('harmonyos');
const elementTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'HarmonyOS reads element text from the captured tree only.',
} as const);
/**
 * Parity with the retired `focus` capability bucket, which the HarmonyOS overlay in
 * `core/capabilities.ts` filled as `{ emulator, device }` — the two kinds hdc can drive.
 */
const focusKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'focus is supported on HarmonyOS emulators and physical devices.',
} as const);
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'HarmonyOS appstate is supported only for HarmonyOS emulators and devices.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);

const lifecycleAvailable = Object.freeze({ available: true } as const);
const openTargetKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'open is supported only for HarmonyOS emulators and devices.',
} as const);
const closeTargetKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'close is supported only for HarmonyOS emulators and devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Port reverse is supported only by an owning provider runtime.',
} as const);
const snapshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'snapshot is supported only for HarmonyOS emulators and devices.',
} as const);
const screenshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'screenshot is supported only for HarmonyOS emulators and devices.',
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

function harmonyLifecycleFacts(device: DeviceInfo) {
  const openTarget = harmonyOpenTargetFact(device);
  const closeTarget = harmonyCloseTargetFact(device);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: unavailable,
    clearRuntimeHints: unavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

function harmonyOpenTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? lifecycleAvailable
    : openTargetKindUnavailable;
}

function harmonyCloseTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? lifecycleAvailable
    : closeTargetKindUnavailable;
}

const gestureKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Gestures are supported on HarmonyOS emulators and physical devices.',
} as const);
/**
 * hdc synthesizes one contact. The retired admission refused two-contact synthesis on every
 * platform that is neither Android nor Apple, with no hint — that is this cell.
 */
const multiTouchUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const targetAuthoredDragUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} as const);

function harmonyGestureFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind === 'emulator' || device.kind === 'device'
    ? available
    : gestureKindUnavailable;
}

function harmonyFocusFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind === 'emulator' || device.kind === 'device' ? available : focusKindUnavailable;
}

/**
 * `orientation` and `tv-remote` never carried a HarmonyOS capability bucket: the family is absent
 * from `HARMONYOS_SUPPORTED_COMMANDS` for both, so both are unavailable unconditionally — even
 * though the interactor's own `setOrientation` is technically callable, admission never reached it.
 */
const harmonyPlatformLeafUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

/** Android's live IME status read has no HarmonyOS counterpart (parity with the retired leaf,
 * which rejected `status`/`get` on every non-Android family). */
const harmonyKeyboardStatusUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'keyboard status/get is not available through the public HarmonyOS HDC API; use keyboard dismiss or enter',
} as const);

const audioProbeUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'audio is supported for web browser sessions, macOS sessions, iOS simulators, and Android emulators on macOS hosts',
} as const);

export function createHarmonyPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createHarmonyAppLogRuntime(host);
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    const deployment = harmonyAppDeploymentFacts(device);
    const recordingFacts = harmonyScreenRecordingFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        ...deployment,
        appState: device.kind === 'simulator' ? appStateUnavailable : available,
        networkDump: unavailable,
        screenRecordingStart: recordingFacts,
        screenRecordingReattach: recordingFacts,
        screenRecordingCleanup: recordingFacts,
        ...snapshotRuntimeOperationFacts({
          capture:
            device.kind === 'emulator' || device.kind === 'device'
              ? available
              : snapshotKindUnavailable,
          customActions: snapshotCustomActionsUnavailable,
          withoutActiveApp:
            device.kind === 'emulator' || device.kind === 'device'
              ? available
              : snapshotKindUnavailable,
        }),
        ...screenshotRuntimeOperationFacts({
          capture:
            device.kind === 'emulator' || device.kind === 'device'
              ? available
              : screenshotKindUnavailable,
        }),
        // No native text reading: every text wait on this owner polls the canonical tree.
        ...selectorObservationRuntimeOperationFacts({
          findText: snapshotKindUnavailable,
          findSelector: snapshotKindUnavailable,
        }),
        ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
        ...focusRuntimeOperationFacts({ focus: harmonyFocusFact(device) }),
        // Gestures share focus's kind cell (the overlay admitted `{emulator, device}`); only the
        // two tiers hdc cannot synthesize are refused.
        ...gestureRuntimeOperationFacts({
          plan: harmonyGestureFact(device),
          directionalFling: harmonyGestureFact(device),
          multiTouch: multiTouchUnavailable,
          targetAuthoredDrag: targetAuthoredDragUnavailable,
          viewport: harmonyGestureFact(device),
        }),
        ...scrollRuntimeOperationFacts({ scroll: harmonyGestureFact(device) }),
        // Text entry shares focus's cell: hdc drives both on the same two kinds.
        ...typeTextRuntimeOperationFacts({ type: harmonyFocusFact(device) }),
        ...touchRuntimeOperationFacts({
          tap: harmonyFocusFact(device),
          tapRef: unavailable,
          longPress: harmonyFocusFact(device),
          hover: unavailable,
          hoverRef: unavailable,
          fill: harmonyFocusFact(device),
          fillRef: unavailable,
          tapElementSelector: unavailable,
        }),
        // HarmonyOS has no point-read tool: `get` answers from the captured tree, which is what
        // the legacy dispatch already did after its Apple-runner attempt failed.
        ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
        ...backRuntimeOperationFacts({ back: harmonyFocusFact(device) }),
        ...homeRuntimeOperationFacts({ home: harmonyFocusFact(device) }),
        // Parity with the retired `HARMONYOS_SUPPORTED_COMMANDS` overlay, which listed
        // `app-switcher` for both HarmonyOS kinds: it rides the same hdc-driven key input `home`
        // does, so it shares that cell.
        ...appSwitcherRuntimeOperationFacts({ appSwitcher: harmonyFocusFact(device) }),
        // HarmonyOS never carried a `trigger-app-event` bucket and is absent from the overlay.
        ...appEventRuntimeOperationFacts({ triggerAppEvent: harmonyPlatformLeafUnavailable }),
        // Parity with the retired `HARMONYOS_SUPPORTED_COMMANDS` overlay, which listed `settings`
        // for both HarmonyOS kinds; the hdc-driven settings surface shares the interaction gate.
        ...settingsRuntimeOperationFacts({ setSetting: harmonyFocusFact(device) }),
        // R59: the retired `alert` descriptor declared no HarmonyOS leaf and the overlay set
        // never listed it, so no HarmonyOS cell was ever admitted.
        ...alertRuntimeOperationFacts({
          read: harmonyPlatformLeafUnavailable,
          wait: harmonyPlatformLeafUnavailable,
          accept: harmonyPlatformLeafUnavailable,
          dismiss: harmonyPlatformLeafUnavailable,
        }),
        ...orientationRuntimeOperationFacts({ orientation: harmonyPlatformLeafUnavailable }),
        ...tvRemoteRuntimeOperationFacts({ tvRemote: harmonyPlatformLeafUnavailable }),
        ...keyboardRuntimeOperationFacts({
          status: harmonyKeyboardStatusUnavailable,
          dismiss: harmonyFocusFact(device),
          enter: harmonyFocusFact(device),
        }),
        // HarmonyOS never carried a `clipboard` capability bucket and is absent from the
        // HarmonyOS overlay set, so no clipboard cell was ever admitted here.
        ...clipboardRuntimeOperationFacts({
          read: harmonyPlatformLeafUnavailable,
          write: harmonyPlatformLeafUnavailable,
        }),
        ...audioProbeRuntimeOperationFacts({
          capture: audioProbeUnavailable,
          query: audioProbeUnavailable,
        }),
        ...perfRuntimeOperationFacts({
          frames: harmonyFocusFact(device),
          memorySample: harmonyFocusFact(device),
          memorySnapshot: harmonyFocusFact(device),
          nativeCapture: harmonyPlatformLeafUnavailable,
          profileReport: harmonyPlatformLeafUnavailable,
        }),
        ensureReady: available,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: available,
        ...harmonyLifecycleFacts(device),
        shutdownTarget: unavailable,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'harmonyos',
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
          ...createHarmonyAppDeploymentOperations({
            commands: host.commands,
            device: request.device,
            signal: request.scope.signal,
          }),
          ...(facts.operations.appState.available
            ? {
                appState: async () =>
                  await readHarmonyAppState(
                    host.appState.harmonyos,
                    request.device,
                    request.scope.signal,
                  ),
              }
            : {}),
          ensureReady: async () => ({ ...request.device, booted: true }),
          ...(recordingFacts.available
            ? createHarmonyScreenRecordingOperations({
                host,
                device: request.device,
                owner,
                signal: request.scope.signal,
              })
            : {}),
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
          ...bindLocalGestureInteractor({
            device: request.device,
            signal: request.scope.signal,
            facts: facts.operations,
            resolveInteractor: host.localInteractors.resolve,
          }),
          ...(facts.operations.scrollDirection.available
            ? bindLocalScrollInteractor({
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
          ...whenAdmitted(facts.operations.perfFrames, () =>
            createHarmonyPerfOperations({
              resolveHost: () => host.perf.harmony,
              device: request.device,
            }),
          ),
          ...whenAdmitted(facts.operations.tapPoint, () =>
            bindLocalTouchInteractor({
              device: request.device,
              signal: request.scope.signal,
              resolveInteractor: host.localInteractors.resolve,
              facts: facts.operations,
              pause: async (milliseconds) =>
                await host.clock.sleep(milliseconds, request.scope.signal),
            }),
          ),
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.harmonyos.listApps(
              input.device,
              input.filter,
              request.scope.signal,
            ),
          ...availableApplicationLifecycleOperations(
            bindHarmonyApplicationLifecycle({
              host: host.localInteractors,
              device: request.device,
              signal: request.scope.signal,
            }),
            facts.operations,
          ),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
