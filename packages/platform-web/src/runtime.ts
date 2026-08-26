import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  sameRuntimeOwner,
  whenAdmitted,
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
import {
  bindLocalFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT } from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import {
  bindLocalScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
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
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { appSwitcherRuntimeOperationFacts } from '@agent-device/contracts/app-switcher-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import {
  audioProbeRuntimeOperationFacts,
  type AudioProbeQueryInput,
} from '@agent-device/contracts/audio-probe-runtime';
import { perfRuntimeOperationFacts } from '@agent-device/contracts/perf-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { bindWebScreenRecordingRuntime } from './recording/runtime.ts';
import { bindWebApplicationLifecycle } from './lifecycle.ts';

const owner = localRuntimeOwner('web');
const available = Object.freeze({ available: true } as const);
const elementTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Web targets read element text from the captured tree only.',
} as const);
const appLogUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'record is not supported by this web provider',
} as const);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Re-run without --actions, or target an iOS simulator.',
} as const);
const readinessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const appsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'apps is not supported on web targets.',
} as const);
const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
// `back`, `home`, `orientation`, `tv-remote`, and every keyboard action never carried a web
// capability bucket (the retired `WEB_SUPPORTED_COMMANDS` overlay never listed them), so all are
// unavailable unconditionally.
const navigationUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);
const nativeRefUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const audioCaptureUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'audio on web sessions is the stateless page probe; host capture is a macOS-host operation.',
} as const);

function webOptionalOperationFact(operation: unknown, browserDevice: RuntimeOperationFact) {
  return typeof operation === 'function' ? browserDevice : nativeRefUnavailable;
}

function webAvailableFact(condition: boolean, unavailable: RuntimeOperationFact) {
  return condition ? available : unavailable;
}

/** `gesture` and `swipe` never carried a web capability bucket; the browser drives no synthesis. */
const gestureUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const targetAuthoredDragUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
} as const);
const openTargetKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'open is supported only for web browser devices.',
} as const);
const closeTargetKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'close is supported only for web browser devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Port reverse is supported only by an owning provider runtime.',
} as const);

function webLifecycleFacts(device: DeviceInfo) {
  const openTarget = webOpenTargetFact(device);
  const closeTarget = webCloseTargetFact(device);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: readinessUnavailable,
    clearRuntimeHints: readinessUnavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

function webOpenTargetFact(device: DeviceInfo) {
  return device.kind === 'device' ? available : openTargetKindUnavailable;
}

function webCloseTargetFact(device: DeviceInfo) {
  return device.kind === 'device' ? available : closeTargetKindUnavailable;
}

export function createWebPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const inspectFacts = async (device: DeviceInfo) => {
    const transport = await host.networkTransports.resolve(device);
    const recording = await bindWebScreenRecordingRuntime({
      host,
      device,
      owner,
      signal: new AbortController().signal,
    });
    const interactor =
      device.kind === 'device' ? await host.localInteractors.resolve(device, {}) : undefined;
    return webRuntimeFacts(device, transport, recording.available, interactor);
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'web',
    inspectFacts,
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Web runtime owner identity does not match');
      }
      if (request.device.platform !== 'web') {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          `Web runtime owner cannot bind ${request.device.platform}`,
        );
      }
      const transport = await host.networkTransports.resolve(request.device);
      const recording = await bindWebScreenRecordingRuntime({
        host,
        device: request.device,
        owner,
        signal: request.scope.signal,
      });
      const interactor =
        request.device.kind === 'device'
          ? await host.localInteractors.resolve(request.device, { signal: request.scope.signal })
          : undefined;
      return bindWebRuntime(
        host,
        request.device,
        request.scope.signal,
        transport,
        recording,
        webRuntimeFacts(request.device, transport, recording.available, interactor),
      );
    },
    shutdown: async () => undefined,
  });
}

function bindWebRuntime(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
  recording: Awaited<ReturnType<typeof bindWebScreenRecordingRuntime>>,
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): DeviceBinding<PlatformRuntimeOperations> {
  const dump = transport.dump;
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = {
    ...(dump
      ? {
          networkDump: async (input) => {
            const result = await dump(
              { maxEntries: input.maxEntries, include: input.include },
              signal,
            );
            return Object.freeze({ source: 'provider' as const, ...result });
          },
        }
      : {}),
    ...recording.operations,
    ...(facts.operations.captureSnapshot.available
      ? bindLocalSnapshotInteractor({
          device,
          signal,
          resolveInteractor: host.localInteractors.resolve,
        })
      : {}),
    ...(facts.operations.captureScreenshot.available
      ? bindLocalScreenshotInteractor({
          device,
          signal,
          resolveInteractor: host.localInteractors.resolve,
        })
      : {}),
    ...(facts.operations.focusPoint.available
      ? bindLocalFocusInteractor({
          device,
          signal,
          resolveInteractor: host.localInteractors.resolve,
        })
      : {}),
    ...(facts.operations.typeText.available
      ? bindLocalTypeTextInteractor({
          device,
          signal,
          resolveInteractor: host.localInteractors.resolve,
        })
      : {}),
    ...whenAdmitted(facts.operations.tapPoint, () =>
      bindLocalTouchInteractor({
        device,
        signal,
        resolveInteractor: host.localInteractors.resolve,
        facts: facts.operations,
        pause: async (milliseconds) => await host.clock.sleep(milliseconds, signal),
      }),
    ),
    ...(facts.operations.scrollDirection.available
      ? bindLocalScrollInteractor({
          device,
          signal,
          resolveInteractor: host.localInteractors.resolve,
        })
      : {}),
    ...(facts.operations.setViewport.available
      ? {
          setViewport: async (input) => {
            signal.throwIfAborted();
            const interactor = await host.localInteractors.resolve(device, { signal });
            if (!interactor.setViewport) {
              throw new AppError(
                'UNSUPPORTED_OPERATION',
                'viewport is not supported by the bound web interactor',
              );
            }
            await interactor.setViewport(input.width, input.height);
            signal.throwIfAborted();
          },
        }
      : {}),
    ...whenAdmitted(facts.operations.audioProbeQuery, () => ({
      audioProbeQuery: async (input: AudioProbeQueryInput) => {
        const transport = await host.audioProbe.web.resolve(device);
        if (transport === undefined) {
          throw new AppError(
            'UNSUPPORTED_OPERATION',
            'audio is not supported by this web provider',
          );
        }
        return await transport.probe(input);
      },
    })),
    ...availableApplicationLifecycleOperations(
      bindWebApplicationLifecycle({ host: host.localInteractors, device, signal }),
      facts.operations,
    ),
  };
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function webRuntimeFacts(
  device: DeviceInfo,
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
  recordingAvailable: boolean,
  interactor: Interactor | undefined,
): RuntimeFacts<PlatformRuntimeOperations> {
  const networkUnavailable = Object.freeze({
    available: false,
    reason: 'owner-capability-missing',
    hint: 'network is not supported by this web provider',
  } as const);
  // One browser-device cell, read by every operation this runtime binds through the interactor.
  const browserDevice = webAvailableFact(device.kind === 'device', openTargetKindUnavailable);
  return Object.freeze({
    device: {
      family: 'web',
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: transport.mode,
    },
    operations: {
      appLogInspect: appLogUnavailable,
      appLogDoctor: appLogUnavailable,
      appLogStart: appLogUnavailable,
      appLogReattach: appLogUnavailable,
      appLogCleanup: appLogUnavailable,
      appState: appStateUnavailable,
      networkDump: webAvailableFact(Boolean(transport.dump), networkUnavailable),
      screenRecordingStart: webAvailableFact(recordingAvailable, recordingUnavailable),
      screenRecordingReattach: webAvailableFact(recordingAvailable, recordingUnavailable),
      screenRecordingCleanup: webAvailableFact(recordingAvailable, recordingUnavailable),
      ...snapshotRuntimeOperationFacts({
        capture: browserDevice,
        customActions: snapshotCustomActionsUnavailable,
        withoutActiveApp: browserDevice,
      }),
      // No native text reading: every text wait on this owner polls the canonical tree.
      ...selectorObservationRuntimeOperationFacts({
        findText: openTargetKindUnavailable,
        findSelector: openTargetKindUnavailable,
      }),
      ...screenshotRuntimeOperationFacts({ capture: browserDevice }),
      // Parity with the retired `focus` capability bucket, which the web overlay in
      // `core/capabilities.ts` filled as `{ device: true }`: the browser device is the only
      // web cell with an interactor to drive.
      ...focusRuntimeOperationFacts({ focus: browserDevice }),
      // Text entry shares focus's cell: the browser device is the only web cell with an
      // interactor to drive (parity with the retired `type` overlay membership).
      ...typeTextRuntimeOperationFacts({ type: browserDevice }),
      ...touchRuntimeOperationFacts({
        tap: browserDevice,
        tapRef: webOptionalOperationFact(interactor?.tapRef, browserDevice),
        longPress: readinessUnavailable,
        hover: webOptionalOperationFact(interactor?.hover, browserDevice),
        hoverRef: webOptionalOperationFact(interactor?.hoverRef, browserDevice),
        fill: browserDevice,
        fillRef: webOptionalOperationFact(interactor?.fillRef, browserDevice),
        tapElementSelector: readinessUnavailable,
      }),
      // `scroll` is the one gesture-family command the web overlay admitted
      // (`WEB_INTERACTION_COMMANDS`), so it shares focus's `{ device: true }` cell. `gesture` and
      // `swipe` never carried a web bucket, and the retired admission refused `platform === 'web'`
      // outright. Drag is the exception it checked FIRST, by naming the phases an adapter needs.
      ...scrollRuntimeOperationFacts({ scroll: browserDevice }),
      ...gestureRuntimeOperationFacts({
        plan: gestureUnavailable,
        directionalFling: gestureUnavailable,
        multiTouch: gestureUnavailable,
        targetAuthoredDrag: targetAuthoredDragUnavailable,
        viewport: gestureUnavailable,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: browserDevice }),
      // The web backend has no point-addressed read: `get` answers from the captured DOM tree,
      // which is what the legacy dispatch already did once its Apple-runner attempt failed.
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
      ...backRuntimeOperationFacts({ back: navigationUnavailable }),
      ...homeRuntimeOperationFacts({ home: navigationUnavailable }),
      ...orientationRuntimeOperationFacts({ orientation: navigationUnavailable }),
      ...tvRemoteRuntimeOperationFacts({ tvRemote: navigationUnavailable }),
      ...keyboardRuntimeOperationFacts({
        status: navigationUnavailable,
        dismiss: navigationUnavailable,
        enter: navigationUnavailable,
      }),
      // The web backend never carried a `clipboard` capability bucket (`WEB_QUERY_COMMANDS`
      // lists `audio` alone), so no clipboard cell was ever admitted here.
      ...clipboardRuntimeOperationFacts({
        read: navigationUnavailable,
        write: navigationUnavailable,
      }),
      // Parity with the retired `WEB_QUERY_COMMANDS` graft, which admitted `audio` on every web
      // device; the provider that carries no probe transport still refuses at execution.
      ...audioProbeRuntimeOperationFacts({ capture: audioCaptureUnavailable, query: available }),
      ...perfRuntimeOperationFacts({
        frames: navigationUnavailable,
        memorySample: navigationUnavailable,
        memorySnapshot: navigationUnavailable,
        nativeCapture: navigationUnavailable,
        profileReport: navigationUnavailable,
      }),
      ...appSwitcherRuntimeOperationFacts({ appSwitcher: navigationUnavailable }),
      ...appEventRuntimeOperationFacts({ triggerAppEvent: navigationUnavailable }),
      ...settingsRuntimeOperationFacts({ setSetting: navigationUnavailable }),
      ...alertRuntimeOperationFacts({
        read: navigationUnavailable,
        wait: navigationUnavailable,
        accept: navigationUnavailable,
        dismiss: navigationUnavailable,
      }),
      ensureReady: readinessUnavailable,
      bootTarget: readinessUnavailable,
      bootTargetHeadless: readinessUnavailable,
      listApps: appsUnavailable,
      deployApp: readinessUnavailable,
      materializeAppSource: readinessUnavailable,
      deployMaterializedApp: readinessUnavailable,
      sendPushNotification: readinessUnavailable,
      shutdownTarget: readinessUnavailable,
      ...webLifecycleFacts(device),
    },
  });
}
