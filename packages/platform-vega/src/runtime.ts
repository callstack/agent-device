import type {
  DeviceBinding,
  RuntimeFacts,
  RuntimeOperationUnavailability,
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
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { localRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { bindVegaApplicationLifecycle } from './lifecycle.ts';

const vegaOwner = localRuntimeOwner('vega');
const lifecycleAvailable = Object.freeze({ available: true } as const);
const unsupportedPlatformLeaf = vegaUnavailable('unsupported-platform-leaf');
const runtimeHintsUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'Runtime hints are supported only for local iOS-family simulators and Android devices.',
);
const appleRunnerUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'Apple runner preparation is supported only for Apple targets.',
);
const providerPortReverseUnavailable = vegaUnavailable(
  'unsupported-provider-mode',
  'Port reverse is supported only by an owning provider runtime.',
);
const openTargetUnavailable = vegaUnavailable(
  'unsupported-device-kind',
  'open currently supports only Vega Virtual Devices.',
);
const closeTargetUnavailable = vegaUnavailable(
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

const screenshotUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'screenshot is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);

const focusUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'focus is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);
const typeUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'type is not supported on Vega OS: the Vega runtime exposes remote navigation only.',
);
// `orientation` and every keyboard action never carried a Vega capability bucket at all; `back`,
// `home`, and `tv-remote` did (the retired `vegaPlugin` closure), gated by the same VVD cell
// their lifecycle open/close already require.
const orientationUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'orientation is not supported on Vega OS.',
);
const keyboardUnavailable = vegaUnavailable(
  'unsupported-platform-leaf',
  'keyboard is not supported on Vega OS.',
);
const backUnavailable = vegaUnavailable(
  'unsupported-device-kind',
  'back currently supports only Vega Virtual Devices.',
);
const homeUnavailable = vegaUnavailable(
  'unsupported-device-kind',
  'home currently supports only Vega Virtual Devices.',
);
const tvRemoteUnavailable = vegaUnavailable(
  'unsupported-device-kind',
  'tv-remote currently supports only Vega Virtual Devices.',
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
    typeText: typeUnavailable,
    elementText: unsupportedPlatformLeaf,
    back: backUnavailable,
    home: homeUnavailable,
    orientation: orientationUnavailable,
    tvRemote: tvRemoteUnavailable,
    keyboardStatus: keyboardUnavailable,
    keyboardDismiss: keyboardUnavailable,
    keyboardEnter: keyboardUnavailable,
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
      ...homeRuntimeOperationFacts({ home: supported ? lifecycleAvailable : homeUnavailable }),
      ...tvRemoteRuntimeOperationFacts({
        tvRemote: supported ? lifecycleAvailable : tvRemoteUnavailable,
      }),
    },
  });
}

function vegaUnavailable(
  reason: RuntimeOperationUnavailability['reason'],
  hint?: string,
): RuntimeOperationUnavailability {
  const fact: RuntimeOperationUnavailability = {
    available: false,
    reason,
    ...(hint === undefined ? {} : { hint }),
  };
  return Object.freeze(fact);
}
