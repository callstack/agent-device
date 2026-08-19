import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
  RuntimeOperationUnavailability,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  createUnavailablePlatformRuntimeFacts,
  localRuntimeOwner,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform';
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
        operations: Object.freeze(
          availableApplicationLifecycleOperations(lifecycle, facts.operations),
        ),
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

function vegaFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const supported = device.kind === 'emulator' && device.target === 'tv';
  const openTarget = supported ? lifecycleAvailable : openTargetUnavailable;
  const closeTarget = supported ? lifecycleAvailable : closeTargetUnavailable;
  return createUnavailablePlatformRuntimeFacts(device, vegaOwner, {
    appLog: unsupportedPlatformLeaf,
    network: unsupportedPlatformLeaf,
    screenshot: screenshotUnavailable,
    snapshot: unsupportedPlatformLeaf,
    viewport: unsupportedPlatformLeaf,
    elementText: unsupportedPlatformLeaf,
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
