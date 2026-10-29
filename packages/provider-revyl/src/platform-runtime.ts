import { AppError } from '@agent-device/kernel/errors';
import { isSupportedRevylRuntimeDevice } from './device.ts';
import {
  providerRuntimeOwner,
  sameRuntimeOwner,
  type DeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import { availableApplicationLifecycleOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { bindRevylInteractionOperations } from './interaction-operations.ts';
import { bindRevylApplicationLifecycle } from './lifecycle.ts';
import { revylFacts, revylUnavailableCells, revylLifecycleFacts } from './facts-runtime.ts';

export type RevylPlatformRuntimeOwnerOptions = Readonly<{
  host: PlatformRuntimeHost;
  runtimeInstance: string;
  ownsDevice(device: DeviceInfo): boolean;
  hasLiveSession(device: DeviceInfo): boolean;
  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
}>;

/**
 * The owner a Revyl runtime hands the host. It owns one thing per device: the interactor bound to
 * that device's live session. Every operation is either an admitted interactor call or a classified
 * refusal, which is why there is no app-log, deployment, or recording machinery beside it.
 */
export function createRevylPlatformRuntimeOwner(
  options: RevylPlatformRuntimeOwnerOptions,
): PlatformRuntimeOwner {
  const owner = providerRuntimeOwner('revyl', options.runtimeInstance);
  const ownsDevice = (device: DeviceInfo) =>
    isSupportedRevylRuntimeDevice(device) && options.ownsDevice(device);
  const hasLiveSession = (device: DeviceInfo) =>
    ownsDevice(device) && options.hasLiveSession(device);
  return Object.freeze({
    owner,
    ownsDevice,
    inspectFacts: async (device) =>
      hasLiveSession(device)
        ? revylFacts(device)
        : createUnavailablePlatformRuntimeFacts(device, owner, {
            ...revylUnavailableCells,
            lifecycle: revylLifecycleFacts(device, false),
          }),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Revyl runtime owner identity does not match');
      }
      if (!isSupportedRevylRuntimeDevice(request.device)) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          'Revyl requires an iOS simulator or Android emulator device identity',
        );
      }
      const live = hasLiveSession(request.device);
      if (request.intent.kind !== 'exact-owner' && !live) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Revyl provider session is no longer live for the selected device',
          { reason: 'provider-session-unavailable' },
        );
      }
      return bindRevylRuntime(options, owner, request.device, request.scope.signal, live);
    },
    shutdown: async () => undefined,
  });
}

function bindRevylRuntime(
  options: RevylPlatformRuntimeOwnerOptions,
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  signal: AbortSignal,
  live: boolean,
): DeviceBinding<PlatformRuntimeOperations> {
  const facts = live
    ? revylFacts(device)
    : createUnavailablePlatformRuntimeFacts(device, owner, {
        ...revylUnavailableCells,
        lifecycle: revylLifecycleFacts(device, false),
      });
  const operations = {
    // A rented device is booted for the whole session, so a readiness read reports what the lease
    // already established rather than probing the worker again.
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    ...availableApplicationLifecycleOperations(
      bindRevylApplicationLifecycle({ device, signal, getInteractor: options.getInteractor }),
      revylLifecycleFacts(device, live),
    ),
    ...bindRevylInteractionOperations({
      device,
      signal,
      getInteractor: options.getInteractor,
      presentIosAcquisition: options.host.snapshot.presentIosAcquisition,
    }),
    ...bindAdmittedProviderInteractorOperations({
      device,
      signal,
      resolveInteractor: (runner) => options.getInteractor(device, runner),
      facts: facts.operations,
    }),
  } satisfies Partial<DeviceBinding<PlatformRuntimeOperations>['operations']>;
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}
