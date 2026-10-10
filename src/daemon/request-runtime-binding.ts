import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import { errorMessage } from '@agent-device/kernel/errors';
import { AsyncCleanupStack } from '@agent-device/contracts/async-lifecycle';
import {
  type BoundDeviceRuntime,
  type DeviceBinding,
  type DeviceBindingIntent,
  type DeviceRuntimeGateway,
  type ResourceOwnershipFence,
  type RuntimeFacts,
  type RuntimeOperationKey,
  type RuntimeOwnerRef,
  type RuntimeUse,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { ensureDeviceReady } from './device/device-ready.ts';
import type { DaemonPlatformServices } from './platform-services.ts';
import { recordBoundMutations, type RequestDispatchLedger } from './request-dispatch-ledger.ts';

export type BindDeviceRuntime = <
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
  const Conditional extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number] | Preferred[number]
  >[],
>(
  device: DeviceInfo,
  use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>,
) => Promise<
  BoundDeviceRuntime<RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>>
>;

export type BindExactDeviceRuntime = <
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
  const Conditional extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number] | Preferred[number]
  >[],
>(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  fence: ResourceOwnershipFence,
  use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>,
  scope: PlatformRequestScope,
) => Promise<
  BoundDeviceRuntime<RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>>
>;

export type InspectDeviceRuntimeFacts = (
  device: DeviceInfo,
) => Promise<RuntimeFacts<PlatformRuntimeOperations>>;

export type BoundDeviceIdentity = Readonly<{
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
}>;

/**
 * Runs local readiness after binding and claim admission; a provider runtime owns its own. The
 * concrete mechanics arrive through the request's platform-services port, so no route can reach a
 * platform it did not receive from root composition.
 */
export async function ensureBoundDeviceReady(
  bound: BoundDeviceIdentity,
  platformServices: DaemonPlatformServices,
): Promise<void> {
  switch (bound.owner.kind) {
    case 'provider-runtime':
      return;
    case 'local-family':
      await ensureDeviceReady(bound.device, platformServices);
  }
}

/**
 * The two request-scoped seams a route needs to admit and prepare a device, beside the two
 * function types it is composed of. `platformServices` rides along because every admitted-device
 * route runs local readiness through the same port; a caller that only forwards the seams still
 * forwards one object rather than one member per platform ask.
 */
export type RuntimeAdmissionBindings = Readonly<{
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
}>;

export type RequestRuntimeBindings = AsyncDisposable &
  Readonly<{
    inspectFacts: InspectDeviceRuntimeFacts;
    bindDevice: BindDeviceRuntime;
    bindExactDevice: BindExactDeviceRuntime;
  }>;

/**
 * Owns request runtime bindings while exposing only the requested operation projection. Every
 * projection records its mutations in the request's `dispatchLedger`, so no route reaches the
 * device without its mutations counting toward the request's disclosure.
 */
export function createRequestRuntimeBindings(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  dispatchLedger: RequestDispatchLedger;
  admitDeviceClaim: (device: DeviceInfo, owner: RuntimeOwnerRef) => Promise<void>;
  /** ADR 0029 daemon-policy device scope, checked before the gateway inspects or binds a device. */
  admitDevice?: (device: DeviceInfo) => void;
}): RequestRuntimeBindings {
  const cleanups = new AsyncCleanupStack();
  const bindings = new Map<string, Promise<DeviceBinding<PlatformRuntimeOperations>>>();

  const admitBinding = async (
    binding: DeviceBinding<PlatformRuntimeOperations>,
  ): Promise<DeviceBinding<PlatformRuntimeOperations>> => {
    await params.admitDeviceClaim(binding.device, binding.owner);
    return binding;
  };

  const bindDevice: BindDeviceRuntime = async (device, use) => {
    params.admitDevice?.(device);
    const key = deviceIdentityKey(deviceIdentity(device));
    let bindingPromise = bindings.get(key);
    if (!bindingPromise) {
      const intent: DeviceBindingIntent = { kind: 'ordinary' };
      bindingPromise = params.gateway
        .bind({ device, intent, scope: params.scope })
        .then((binding) => cleanups.use(binding))
        .then(admitBinding);
      bindings.set(key, bindingPromise);
      void bindingPromise.catch(() => {
        if (bindings.get(key) === bindingPromise) bindings.delete(key);
      });
    }
    return recordBoundMutations(
      narrowDeviceBinding(await bindingPromise, use),
      params.dispatchLedger,
    );
  };

  const bindExactDevice: BindExactDeviceRuntime = async (device, owner, fence, use, scope) => {
    params.admitDevice?.(device);
    const intent: DeviceBindingIntent = { kind: 'exact-owner', owner, fence };
    const published = await params.gateway.bind({ device, intent, scope });
    const adopted = await adoptExactBinding(cleanups, published, scope);
    const binding = await admitBinding(adopted);
    return recordBoundMutations(narrowDeviceBinding(binding, use), params.dispatchLedger);
  };

  return {
    inspectFacts: async (device) => {
      params.admitDevice?.(device);
      return await params.gateway.inspectFacts(device);
    },
    bindDevice,
    bindExactDevice,
    [Symbol.asyncDispose]: async () => {
      await cleanups[Symbol.asyncDispose]();
    },
  };
}

async function adoptExactBinding(
  cleanups: AsyncCleanupStack,
  binding: DeviceBinding<PlatformRuntimeOperations>,
  scope: PlatformRequestScope,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  try {
    return cleanups.use(binding);
  } catch (primaryError) {
    try {
      await binding[Symbol.asyncDispose]();
    } catch (cleanupError) {
      scope.diagnostics.emit({
        level: 'error',
        phase: 'request_runtime_late_binding_cleanup_failed',
        data: {
          error: errorMessage(cleanupError),
          primaryError: errorMessage(primaryError),
        },
      });
    }
    throw primaryError;
  }
}
