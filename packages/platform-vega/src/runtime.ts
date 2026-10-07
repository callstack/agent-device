import type { DeviceBinding, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
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
import { systemButtonRuntimeOperationFacts } from '@agent-device/contracts/system-button-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import {
  localRuntimeOwner,
  sameRuntimeOwner,
  unavailableFact,
} from '@agent-device/contracts/platform-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import { TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT } from '@agent-device/contracts/gesture-admission';
import { gestureRuntimeOperationFacts } from '@agent-device/contracts/gesture-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { bindVegaApplicationLifecycle } from './lifecycle.ts';

const vegaOwner = localRuntimeOwner('vega');
const lifecycleAvailable = Object.freeze({ available: true } as const);
const unsupportedPlatformLeaf = unavailableFact('unsupported-platform-leaf');
const runtimeHintsUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'Runtime hints are supported only for local iOS-family simulators and Android devices.',
);
const appleRunnerUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'Apple runner preparation is supported only for Apple targets.',
);
const providerPortReverseUnavailable = unavailableFact(
  'unsupported-provider-mode',
  'Port reverse is supported only by an owning provider runtime.',
);
const openTargetUnavailable = unavailableFact(
  'unsupported-device-kind',
  'open currently supports only Vega Virtual Devices.',
);
const closeTargetUnavailable = unavailableFact(
  'unsupported-device-kind',
  'close currently supports only Vega Virtual Devices.',
);
export function createVegaPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  return Object.freeze({
    owner: vegaOwner,
    ownsDevice: (device) => device.platform === 'vega',
    inspectFacts: async (device) => vegaFacts(device),
    bind: async (request) => {
      if (
        request.intent.kind === 'exact-owner' &&
        !sameRuntimeOwner(request.intent.owner, vegaOwner)
      ) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Vega runtime owner identity does not match');
      }
      if (request.device.platform !== 'vega') {
        throw new AppError('UNSUPPORTED_PLATFORM', 'Vega runtime cannot bind this device');
      }
      const facts = vegaFacts(request.device);
      const lifecycle = bindVegaApplicationLifecycle({
        host: host.localInteractors,
        device: request.device,
        signal: request.scope.signal,
      });
      return Object.freeze({
        device: request.device,
        owner: vegaOwner,
        facts,
        operations: Object.freeze({
          ...availableApplicationLifecycleOperations(lifecycle, facts.operations),
          ...bindAdmittedLocalInteractorOperations({
            device: request.device,
            signal: request.scope.signal,
            resolveInteractor: host.localInteractors.resolve,
            facts: facts.operations,
          }),
        }),
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => undefined,
  });
}

const screenshotUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'screenshot is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);

const focusUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'focus is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);
const typeUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'type is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);

const gestureUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'Gestures are not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);
const scrollUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'scroll is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);
/**
 * The two tiers the retired admission refused BY NAME on a non-Android, non-Apple platform, in its
 * own wording: two-contact synthesis with no hint at all, and target-authored drag by naming the
 * phases an adapter has to preserve.
 */
const multiTouchUnavailable = unavailableFact('unsupported-platform-leaf');
const targetAuthoredDragUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
);
// `orientation` and every keyboard action never carried a Vega capability bucket at all; `back`,
// `home`, and `tv-remote` did (the retired `vegaPlugin` closure), gated by the same VVD cell
// their lifecycle open/close already require.
const orientationUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'orientation is not supported on Vega OS.',
);
const keyboardUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'keyboard is not supported on Vega OS.',
);
const alertUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'alert is not supported on Vega OS.',
);
const settingsUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'settings is not supported on Vega OS.',
);
const appEventUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'trigger-app-event is not supported on Vega OS.',
);
const systemButtonUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'System buttons other than home are not supported on Vega OS.',
);
const foldUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'fold is not supported on Vega OS.',
);
const clipboardUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'clipboard is not supported on Vega OS.',
);
const backUnavailable = unavailableFact(
  'unsupported-device-kind',
  'back currently supports only Vega Virtual Devices.',
);
const homeUnavailable = unavailableFact(
  'unsupported-device-kind',
  'home currently supports only Vega Virtual Devices.',
);
const tvRemoteUnavailable = unavailableFact(
  'unsupported-device-kind',
  'tv-remote currently supports only Vega Virtual Devices.',
);
const audioProbeUnavailable = unavailableFact(
  'unsupported-platform-leaf',
  'audio is supported for web browser sessions, macOS sessions, iOS simulators, and Android emulators on macOS hosts',
);

function vegaFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const supported = device.kind === 'emulator' && device.target === 'tv';
  const openTarget = supported ? lifecycleAvailable : openTargetUnavailable;
  const closeTarget = supported ? lifecycleAvailable : closeTargetUnavailable;
  const unavailable = createUnavailablePlatformRuntimeFacts(device, vegaOwner, {
    appLog: unsupportedPlatformLeaf,
    network: unsupportedPlatformLeaf,
    screenshot: screenshotUnavailable,
    snapshot: unsupportedPlatformLeaf,
    viewport: unsupportedPlatformLeaf,
    // Vega exposes remote navigation only; it never carried a `focus` capability bucket.
    focus: focusUnavailable,
    // Vega exposes remote navigation only; `gesture`, `scroll` and `swipe` never carried a vega
    // capability bucket, so no gesture-family cell was ever admitted here.
    gesture: gestureUnavailable,
    scroll: scrollUnavailable,
    typeText: typeUnavailable,
    touch: unsupportedPlatformLeaf,
    elementText: unsupportedPlatformLeaf,
    back: backUnavailable,
    orientation: orientationUnavailable,
    tvRemote: tvRemoteUnavailable,
    clipboard: clipboardUnavailable,
    systemButton: systemButtonUnavailable,
    fold: foldUnavailable,
    triggerAppEvent: appEventUnavailable,
    settings: settingsUnavailable,
    readAlert: alertUnavailable,
    awaitAlert: alertUnavailable,
    acceptAlert: alertUnavailable,
    dismissAlert: alertUnavailable,
    keyboard: keyboardUnavailable,
    audioProbeCapture: audioProbeUnavailable,
    audioProbeQuery: audioProbeUnavailable,
    perf: unsupportedPlatformLeaf,
    readiness: unsupportedPlatformLeaf,
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: openTarget,
      prepareApplicationOpen: openTarget,
      openApplication: openTarget,
      applyRuntimeHints: runtimeHintsUnavailable,
      clearRuntimeHints: runtimeHintsUnavailable,
      closeApplication: closeTarget,
      finalizeApplicationClose: closeTarget,
      prepareAppleRunner: appleRunnerUnavailable,
      configureProviderPortReverse: providerPortReverseUnavailable,
    }),
  });
  return Object.freeze({
    device: unavailable.device,
    operations: {
      ...unavailable.operations,
      // Remote navigation is the Vega runtime's first available interaction surface: the
      // VVD-only gate the retired `vegaPlugin` closure applied to all three.
      ...backRuntimeOperationFacts({ back: supported ? lifecycleAvailable : backUnavailable }),
      ...systemButtonRuntimeOperationFacts({
        unsupported: systemButtonUnavailable,
        home: supported ? lifecycleAvailable : homeUnavailable,
      }),
      ...tvRemoteRuntimeOperationFacts({
        tvRemote: supported ? lifecycleAvailable : tvRemoteUnavailable,
      }),
      // Two gesture tiers keep the retired closures' own wording instead of this owner's generic
      // one; the rest had no retired closure and now refuse at admission rather than inside the
      // Vega interactor.
      ...gestureRuntimeOperationFacts({
        unsupported: gestureUnavailable,
        multiTouch: multiTouchUnavailable,
        targetAuthoredDrag: targetAuthoredDragUnavailable,
      }),
    },
  });
}
