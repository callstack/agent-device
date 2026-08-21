import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  bindLocalFocusInteractor,
  bindLocalScreenshotInteractor,
  bindLocalTypeTextInteractor,
  bindLocalSnapshotInteractor,
  elementTextRuntimeOperationFacts,
  focusRuntimeOperationFacts,
  typeTextRuntimeOperationFacts,
  localRuntimeOwner,
  screenshotRuntimeOperationFacts,
  selectorObservationRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  sameRuntimeOwner,
  viewportRuntimeOperationFacts,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
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
    return webRuntimeFacts(device, transport, recording.available);
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
      return bindWebRuntime(
        host,
        request.device,
        request.scope.signal,
        transport,
        recording,
        webRuntimeFacts(request.device, transport, recording.available),
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
): RuntimeFacts<PlatformRuntimeOperations> {
  const networkUnavailable = Object.freeze({
    available: false,
    reason: 'owner-capability-missing',
    hint: 'network is not supported by this web provider',
  } as const);
  // One browser-device cell, read by every operation this runtime binds through the interactor.
  const browserDevice = device.kind === 'device' ? available : openTargetKindUnavailable;
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
      networkDump: transport.dump ? available : networkUnavailable,
      screenRecordingStart: recordingAvailable ? available : recordingUnavailable,
      screenRecordingReattach: recordingAvailable ? available : recordingUnavailable,
      screenRecordingCleanup: recordingAvailable ? available : recordingUnavailable,
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
      ...viewportRuntimeOperationFacts({ setViewport: browserDevice }),
      // The web backend has no point-addressed read: `get` answers from the captured DOM tree,
      // which is what the legacy dispatch already did once its Apple-runner attempt failed.
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
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
