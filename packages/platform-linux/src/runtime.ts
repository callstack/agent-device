import type {
  DeviceBinding,
  CaptureSnapshotInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
  RuntimeOperationUnavailability,
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
import { localRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  bindLocalScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  captureSnapshotSignal,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import {
  bindLocalTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { bindLinuxApplicationLifecycle } from './lifecycle.ts';

const supported = Object.freeze({ available: true } as const);
const linuxOwner = localRuntimeOwner('linux');
const unsupportedPlatformLeaf = unavailableLinuxRuntimeFact('unsupported-platform-leaf');
const elementTextKindUnavailable = unavailableLinuxRuntimeFact('unsupported-device-kind');
const focusKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'focus is supported only for the Linux desktop device.',
);
const typeKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'type is supported only for the Linux desktop device.',
);
const runtimeHintsUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-platform-leaf',
  'Runtime hints are supported only for local iOS-family simulators and Android devices.',
);
const appleRunnerUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-platform-leaf',
  'Apple runner preparation is supported only for Apple targets.',
);
const providerPortReverseUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-provider-mode',
  'Port reverse is supported only by an owning provider runtime.',
);
const openTargetKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'open is supported only for the Linux desktop device.',
);
const closeTargetKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'close is supported only for the Linux desktop device.',
);
const snapshotKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'snapshot is supported only for the Linux desktop device.',
);
const screenshotKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'screenshot is supported only for the Linux desktop device.',
);
const snapshotCustomActionsUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-platform-leaf',
  'Re-run without --actions, or target an iOS simulator.',
);
export function createLinuxPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  return Object.freeze({
    owner: linuxOwner,
    ownsDevice: (device) => device.platform === 'linux',
    inspectFacts: async (device) => linuxFacts(device),
    bind: async (request) => {
      if (
        request.intent.kind === 'exact-owner' &&
        !sameRuntimeOwner(request.intent.owner, linuxOwner)
      ) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Linux runtime owner identity does not match');
      }
      if (request.device.platform !== 'linux') {
        throw new AppError('UNSUPPORTED_PLATFORM', 'Linux runtime cannot bind this device');
      }
      const facts = linuxFacts(request.device);
      const lifecycle = bindLinuxApplicationLifecycle({
        host: host.localInteractors,
        device: request.device,
        signal: request.scope.signal,
      });
      return Object.freeze({
        device: request.device,
        owner: linuxOwner,
        facts,
        operations: Object.freeze({
          ...availableApplicationLifecycleOperations(lifecycle, facts.operations),
          ...(facts.operations.captureSnapshot.available
            ? linuxSnapshotOperations(host, request)
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
          ...(facts.operations.readTextAtPoint.available
            ? bindElementTextRuntime({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
        }),
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => undefined,
  });
}

function linuxFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const openTarget = device.kind === 'device' ? supported : openTargetKindUnavailable;
  const closeTarget = device.kind === 'device' ? supported : closeTargetKindUnavailable;
  const unavailable = createUnavailablePlatformRuntimeFacts(device, linuxOwner, {
    appLog: unsupportedPlatformLeaf,
    network: unsupportedPlatformLeaf,
    screenshot: screenshotKindUnavailable,
    snapshot: snapshotKindUnavailable,
    viewport: unsupportedPlatformLeaf,
    focus: focusKindUnavailable,
    typeText: typeKindUnavailable,
    elementText: elementTextKindUnavailable,
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
      ...snapshotRuntimeOperationFacts({
        capture: device.kind === 'device' ? supported : snapshotKindUnavailable,
        customActions: snapshotCustomActionsUnavailable,
        withoutActiveApp: device.kind === 'device' ? supported : snapshotKindUnavailable,
      }),
      ...screenshotRuntimeOperationFacts({
        capture: device.kind === 'device' ? supported : screenshotKindUnavailable,
      }),
      // Parity with the retired `focus` capability bucket (`{ device: true }`): the desktop is
      // the only Linux cell with a pointer to drive.
      ...focusRuntimeOperationFacts({
        focus: device.kind === 'device' ? supported : focusKindUnavailable,
      }),
      // Text entry shares focus's cell: ydotool drives both on the desktop device only.
      ...typeTextRuntimeOperationFacts({
        type: device.kind === 'device' ? supported : typeKindUnavailable,
      }),
      // The Linux read is value-first (AXValue/title/description) where the captured tree is
      // label-first, so the desktop row genuinely reads differently from its snapshot text.
      ...elementTextRuntimeOperationFacts({
        readTextAtPoint: device.kind === 'device' ? supported : elementTextKindUnavailable,
      }),
    },
  });
}

function linuxSnapshotOperations(
  host: PlatformRuntimeHost,
  request: Parameters<PlatformRuntimeOwner['bind']>[0],
) {
  const captureSnapshot = async (input: CaptureSnapshotInput) =>
    await host.snapshot.captureSurface(
      request.device,
      input.options,
      captureSnapshotSignal(request.scope.signal, input),
    );
  return Object.freeze({
    captureSnapshot,
    captureSnapshotWithCustomActions: captureSnapshot,
    captureSnapshotWithoutActiveApp: captureSnapshot,
  });
}

function unavailableLinuxRuntimeFact(
  reason: RuntimeOperationUnavailability['reason'],
  hint?: string,
): RuntimeOperationUnavailability {
  return Object.freeze(
    hint === undefined ? { available: false, reason } : { available: false, reason, hint },
  );
}
