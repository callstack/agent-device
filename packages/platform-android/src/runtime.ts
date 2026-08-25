import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import type { NetworkDumpInput } from '@agent-device/contracts/network-runtime';
import type {
  DeviceBinding,
  RuntimeFacts,
  RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { elementTextRuntimeOperationFacts } from '@agent-device/contracts/element-text-runtime';
import { focusRuntimeOperationFacts } from '@agent-device/contracts/focus-runtime';
import {
  ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import { scrollRuntimeOperationFacts } from '@agent-device/contracts/scroll-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { selectorObservationRuntimeOperationFacts } from '@agent-device/contracts/selector-observation-runtime';
import {
  bindLocalSnapshotInteractor,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import { typeTextRuntimeOperationFacts } from '@agent-device/contracts/type-text-runtime';
import { touchRuntimeOperationFacts } from '@agent-device/contracts/touch-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { appSwitcherRuntimeOperationFacts } from '@agent-device/contracts/app-switcher-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { bindLocalInteractorOperationSet } from '@agent-device/contracts/local-interactor-operation-set';
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
import type { AndroidClipboardShellSupport } from '@agent-device/contracts/android-clipboard-support';
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

const gestureKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Gestures are supported on Android emulators and physical devices.',
} as const);
const androidTvMultiTouchUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: ANDROID_TV_MULTI_TOUCH_UNSUPPORTED_HINT,
} as const);
const androidTvDragUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} as const);

/**
 * A TV target has no touch input at all, which is the one Android gate the retired admission
 * carried — it applied to two-contact synthesis and to target-authored drag, never to a plain
 * one-contact fling or pan (the D-pad adapter executes those).
 */
function androidTouchTargetFact(device: DeviceInfo, refusal: RuntimeOperationFact) {
  if (device.kind === 'simulator') return gestureKindUnavailable;
  return device.target === 'tv' ? refusal : available;
}

function androidGestureFact(device: DeviceInfo) {
  return device.kind === 'simulator' ? gestureKindUnavailable : available;
}

/** adb drives every interaction cell the same way; only the synthetic `simulator` row lacks a device. */
function androidTouchFact(device: DeviceInfo) {
  return device.kind === 'simulator' ? focusKindUnavailable : available;
}

const clipboardShellUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'This Android build ships no shell implementation for the clipboard service, so adb cannot read or write the clipboard on it.',
} as const);

/**
 * The probe could not reach the device, so this owner does not know whether the build supports a
 * shell clipboard. Refusing is the conservative answer and the only honest one: reporting
 * available would hand the caller a capability execution may immediately reject, which is the
 * exact failure fact-based admission exists to prevent. Deliberately not cached — the next
 * inspection asks again.
 */
const clipboardShellUnknown = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'Could not determine whether this Android build supports a shell clipboard: the adb probe did not complete. Retry once the device is reachable.',
} as const);

/**
 * `probe-failed` covers both ways this owner can end up without an answer: the probe ran and could
 * not reach the device, or the host exposes no probe at all. Neither is evidence of support, and
 * both refuse rather than guess.
 */
async function probeClipboardShellSupport(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
): Promise<AndroidClipboardShellSupport> {
  const probe = host.androidTools?.probeClipboardShellSupport;
  if (!probe) return 'probe-failed';
  return await probe.call(host.androidTools, device);
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
  /**
   * `cmd clipboard` is not implemented on every Android build. The retired capability bucket
   * admitted the clipboard on every real Android kind and the leaf discovered the refusal only
   * once a read or write had already run — a device `capabilities` advertised and execution then
   * rejected. ADR 0019 §2 requires the opposite, so support is a fact, and the fact needs a probe.
   *
   * Cached per device for this owner's lifetime: a build's shell command set cannot change while
   * the device is up, and admission would otherwise pay an adb round trip per request.
   */
  const clipboardShell = new Map<string, AndroidClipboardShellSupport>();
  const clipboardFact = async (device: DeviceInfo): Promise<RuntimeOperationFact> => {
    if (device.kind === 'simulator') return clipboardShellUnavailable;
    const support =
      clipboardShell.get(device.id) ?? (await probeClipboardShellSupport(host, device));
    // Only a definitive answer is worth keeping: a build's shell command set cannot change while
    // the device is up, but a failed probe says nothing about the build and must not become a
    // verdict this owner repeats for the rest of its life.
    if (support !== 'probe-failed') clipboardShell.set(device.id, support);
    if (support === 'supported') return available;
    return support === 'unsupported' ? clipboardShellUnavailable : clipboardShellUnknown;
  };
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    const deployment = androidAppDeploymentFacts(device);
    const clipboardCell = await clipboardFact(device);
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
        ...gestureRuntimeOperationFacts({
          plan: androidGestureFact(device),
          directionalFling: androidGestureFact(device),
          multiTouch: androidTouchTargetFact(device, androidTvMultiTouchUnavailable),
          targetAuthoredDrag: androidTouchTargetFact(device, androidTvDragUnavailable),
          viewport: androidGestureFact(device),
        }),
        // `scroll` had no admission beyond its capability bucket, so its cell is that bucket
        // verbatim: every Android kind but the synthetic `simulator` row.
        ...scrollRuntimeOperationFacts({ scroll: androidGestureFact(device) }),
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
        // `app-switcher` shares `home`'s cell: one `input keyevent`, admitted wherever the
        // retired `ANDROID_ALL` bucket admitted it.
        ...appSwitcherRuntimeOperationFacts({ appSwitcher: androidTouchFact(device) }),
        // The deep link opens through `am start`, admitted wherever the retired `ANDROID_ALL`
        // bucket admitted it.
        ...appEventRuntimeOperationFacts({ triggerAppEvent: androidTouchFact(device) }),
        // Settings run over adb (`appops`, `settings put`, `pm clear`, …) on every real kind, so
        // the cell is the retired `ANDROID_ALL` bucket verbatim.
        ...settingsRuntimeOperationFacts({ setSetting: androidTouchFact(device) }),
        // R59: Android reads alerts out of the same accessibility dump every interaction cell
        // depends on and presses their buttons with the same `input tap`, so all four legs take
        // that cell — the retired `ANDROID_ALL` bucket verbatim.
        ...alertRuntimeOperationFacts({
          read: androidTouchFact(device),
          wait: androidTouchFact(device),
          accept: androidTouchFact(device),
          dismiss: androidTouchFact(device),
        }),
        ...orientationRuntimeOperationFacts({ orientation: androidTouchFact(device) }),
        ...tvRemoteRuntimeOperationFacts({ tvRemote: androidTvRemoteFact(device) }),
        // The only owner with a live IME status read; dismiss/enter share every other
        // interaction cell's kind gate (parity with the retired `keyboard` bucket).
        ...keyboardRuntimeOperationFacts({
          status: androidTouchFact(device),
          dismiss: androidTouchFact(device),
          enter: androidTouchFact(device),
        }),
        // Read and write share one cell: `cmd clipboard` either has a shell implementation on this
        // build or it has none, and no Android build ships one half of it.
        ...clipboardRuntimeOperationFacts({ read: clipboardCell, write: clipboardCell }),
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
          ...androidInteractionOperations(host, request, facts),
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

/**
 * The interactor-backed operations, each independently gated by its own admitted fact. Extracted
 * for the same reason the Linux owner extracts its own: `bind` composes owners, it does not read
 * facts one ternary at a time.
 */
function androidInteractionOperations(
  host: PlatformRuntimeHost,
  request: Parameters<PlatformRuntimeOwner['bind']>[0],
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): Partial<DeviceBinding<PlatformRuntimeOperations>['operations']> {
  const resolver = {
    device: request.device,
    signal: request.scope.signal,
    resolveInteractor: host.localInteractors.resolve,
  };
  return {
    ...(facts.operations.captureSnapshot.available ? bindLocalSnapshotInteractor(resolver) : {}),
    ...bindLocalInteractorOperationSet({
      ...resolver,
      facts: facts.operations,
      pause: async (milliseconds) => await host.clock.sleep(milliseconds, request.scope.signal),
    }),
  };
}
