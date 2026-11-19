import { setTimeout as sleep } from 'node:timers/promises';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  providerRuntimeOwner,
  sameRuntimeOwner,
  unavailableFact,
  type DeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  bindProviderScreenshotInteractor,
  defaultCaptureOnly,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import {
  bindProviderSnapshotInteractor,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { VPHONE_PROVIDER } from './connection.ts';
import type { VphoneRuntime } from './runtime.ts';

const available = Object.freeze({ available: true } as const);
const unsupported = unavailableFact(
  'unsupported-provider-mode',
  'This operation is outside the vphone provider first slice.',
);

export function createVphonePlatformRuntimeOwner(options: {
  host: PlatformRuntimeHost;
  runtime: VphoneRuntime;
}): PlatformRuntimeOwner {
  const owner = providerRuntimeOwner(VPHONE_PROVIDER, VPHONE_PROVIDER);
  return Object.freeze({
    owner,
    ownsDevice: (device) => options.runtime.ownsDevice(device),
    inspectFacts: async (device) => factsFor(options.runtime, device, owner),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'vphone runtime owner identity does not match.',
        );
      }
      if (!options.runtime.hasLiveSession(request.device)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'The vphone provider session is not live.', {
          reason: 'provider-session-unavailable',
        });
      }
      return bindVphone(options, request.device, request.scope.signal, owner);
    },
    shutdown: async () => undefined,
  });
}

function factsFor(
  runtime: VphoneRuntime,
  device: DeviceInfo,
  owner: ReturnType<typeof providerRuntimeOwner>,
): RuntimeFacts<PlatformRuntimeOperations> {
  const base = unavailableFacts(device, owner);
  if (!runtime.hasLiveSession(device)) return base;
  return Object.freeze({
    device: base.device,
    operations: Object.freeze({
      ...base.operations,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions: unsupported,
        withoutActiveApp: unsupported,
      }),
      ...screenshotRuntimeOperationFacts({ capture: available }),
      ...focusRuntimeOperationFacts({ focus: available }),
      ...typeTextRuntimeOperationFacts({ type: available }),
      ...touchRuntimeOperationFacts({
        unsupported,
        tap: available,
        longPress: available,
        fill: unsupported,
        tapElementSelector: available,
      }),
      ...scrollRuntimeOperationFacts({ scroll: available }),
      ensureReady: available,
      bootTarget: available,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: available,
        prepareApplicationOpen: available,
        openApplication: available,
        applyRuntimeHints: unsupported,
        clearRuntimeHints: unsupported,
        closeApplication: available,
        finalizeApplicationClose: available,
        prepareAppleRunner: unsupported,
        configureProviderPortReverse: unsupported,
      }),
    }),
  });
}

function unavailableFacts(
  device: DeviceInfo,
  owner: ReturnType<typeof providerRuntimeOwner>,
): RuntimeFacts<PlatformRuntimeOperations> {
  return createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: unsupported,
    apps: unsupported,
    appDeployment: unsupported,
    appState: unsupported,
    network: unsupported,
    screenRecording: unsupported,
    screenshot: unsupported,
    snapshot: unsupported,
    viewport: unsupported,
    focus: unsupported,
    gesture: unsupported,
    scroll: unsupported,
    typeText: unsupported,
    touch: unsupported,
    elementText: unsupported,
    back: unsupported,
    orientation: unsupported,
    fold: unsupported,
    telephony: unsupported,
    tvRemote: unsupported,
    keyboard: unsupported,
    clipboard: unsupported,
    systemButton: unsupported,
    triggerAppEvent: unsupported,
    settings: unsupported,
    readAlert: unsupported,
    awaitAlert: unsupported,
    acceptAlert: unsupported,
    dismissAlert: unsupported,
    audioProbeCapture: unsupported,
    audioProbeQuery: unsupported,
    perf: unsupported,
    readiness: unsupported,
    shutdown: unsupported,
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: unsupported,
      prepareApplicationOpen: unsupported,
      openApplication: unsupported,
      applyRuntimeHints: unsupported,
      clearRuntimeHints: unsupported,
      closeApplication: unsupported,
      finalizeApplicationClose: unsupported,
      prepareAppleRunner: unsupported,
      configureProviderPortReverse: unsupported,
    }),
  });
}

function bindVphone(
  options: { host: PlatformRuntimeHost; runtime: VphoneRuntime },
  device: DeviceInfo,
  signal: AbortSignal,
  owner: ReturnType<typeof providerRuntimeOwner>,
): DeviceBinding<PlatformRuntimeOperations> {
  const facts = factsFor(options.runtime, device, owner);
  const resolveInteractor = (runner?: Parameters<VphoneRuntime['getInteractor']>[1]) =>
    options.runtime.getInteractor(device, runner);
  const lifecycle = bindDirectApplicationLifecycle({
    owner: 'vphone',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: false,
    binding: bindProviderApplicationLifecycleInteractor({ device, signal, resolveInteractor }),
  });
  const operations = {
    ensureReady: async () => ({ ...device, booted: true as const }),
    bootTarget: async () => ({ ...device, booted: true as const }),
    ...availableApplicationLifecycleOperations(lifecycle, facts.operations),
    ...bindProviderSnapshotInteractor({
      device,
      signal,
      resolveInteractor,
      presentIosAcquisition: options.host.snapshot.presentIosAcquisition,
    }),
    ...bindProviderScreenshotInteractor({
      device,
      signal,
      resolveInteractor,
      captureCapabilities: defaultCaptureOnly('vphone captures through the guest PNG endpoint'),
    }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTouchInteractor({
      device,
      signal,
      resolveInteractor,
      facts: facts.operations,
      pause: async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
  } satisfies DeviceBinding<PlatformRuntimeOperations>['operations'];
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}
