import type {
  DeviceBinding,
  RuntimeFacts,
  RuntimeOperationFact,
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
import {
  bindElementTextRuntime,
  elementTextRuntimeOperationFacts,
} from '@agent-device/contracts/element-text-runtime';
import {
  bindLocalFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { bindAdmittedLocalInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { localRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  bindLocalScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  captureSnapshotSignal,
  snapshotRuntimeOperationFacts,
  type CaptureSnapshotInput,
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
const backKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'back is supported only for the Linux desktop device.',
);
const homeKindUnavailable = unavailableLinuxRuntimeFact(
  'unsupported-device-kind',
  'home is supported only for the Linux desktop device.',
);
// `orientation`, `tv-remote`, and every keyboard action never carried a Linux capability bucket
// at all (the retired descriptors declared `linux: {}`), so they are unavailable unconditionally.
const linuxPlatformLeafUnavailable = unsupportedPlatformLeaf;
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
          ...linuxInteractionOperations(host, request, facts),
        }),
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => undefined,
  });
}

/** The five desktop-interactor operations, each independently gated by its own admitted fact. */
function linuxInteractionOperations(
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
    ...(facts.operations.captureScreenshot.available
      ? bindLocalScreenshotInteractor(resolver)
      : {}),
    ...(facts.operations.focusPoint.available ? bindLocalFocusInteractor(resolver) : {}),
    ...(facts.operations.typeText.available ? bindLocalTypeTextInteractor(resolver) : {}),
    ...(facts.operations.readTextAtPoint.available ? bindElementTextRuntime(resolver) : {}),
    ...bindAdmittedLocalInteractorOperations({
      ...resolver,
      facts: facts.operations,
    }),
  };
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
    back: backKindUnavailable,
    home: homeKindUnavailable,
    orientation: linuxPlatformLeafUnavailable,
    tvRemote: linuxPlatformLeafUnavailable,
    keyboardStatus: linuxPlatformLeafUnavailable,
    keyboardDismiss: linuxPlatformLeafUnavailable,
    keyboardEnter: linuxPlatformLeafUnavailable,
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
        capture: linuxDesktopFact(device, snapshotKindUnavailable),
        customActions: snapshotCustomActionsUnavailable,
        withoutActiveApp: linuxDesktopFact(device, snapshotKindUnavailable),
      }),
      ...screenshotRuntimeOperationFacts({
        capture: linuxDesktopFact(device, screenshotKindUnavailable),
      }),
      // Parity with the retired `focus` capability bucket (`{ device: true }`): the desktop is
      // the only Linux cell with a pointer to drive.
      ...focusRuntimeOperationFacts({ focus: linuxDesktopFact(device, focusKindUnavailable) }),
      // Text entry shares focus's cell: ydotool drives both on the desktop device only.
      ...typeTextRuntimeOperationFacts({ type: linuxDesktopFact(device, typeKindUnavailable) }),
      // The Linux read is value-first (AXValue/title/description) where the captured tree is
      // label-first, so the desktop row genuinely reads differently from its snapshot text.
      ...elementTextRuntimeOperationFacts({
        readTextAtPoint: linuxDesktopFact(device, elementTextKindUnavailable),
      }),
      // Parity with the retired `back`/`home` capability bucket (`{ device: true }`): the desktop
      // is the only Linux cell with a target to drive.
      ...backRuntimeOperationFacts({ back: linuxDesktopFact(device, backKindUnavailable) }),
      ...homeRuntimeOperationFacts({ home: linuxDesktopFact(device, homeKindUnavailable) }),
    },
  });
}

/** Every desktop-interactor cell reads the same way: only the Linux `device` kind has one. */
function linuxDesktopFact(
  device: DeviceInfo,
  whenUnavailable: RuntimeOperationUnavailability,
): RuntimeOperationFact {
  return device.kind === 'device' ? supported : whenUnavailable;
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
