import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import {
  AsyncCleanupStack,
  narrowDeviceBinding,
  type BoundDeviceRuntime,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
  type PlatformRequestScope,
  type ResourceOwnershipFence,
  type RuntimeOperationKey,
  type RuntimeOwnerRef,
  type RuntimeFacts,
  type RuntimeUse,
} from '@agent-device/contracts/platform';

export type BindDeviceRuntime = <
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
>(
  device: DeviceInfo,
  use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred>,
) => Promise<BoundDeviceRuntime<RuntimeUse<PlatformRuntimeOperations, Required, Preferred>>>;

export type BindExactDeviceRuntime = <
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
>(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  fence: ResourceOwnershipFence,
  use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred>,
  scope: PlatformRequestScope,
) => Promise<BoundDeviceRuntime<RuntimeUse<PlatformRuntimeOperations, Required, Preferred>>>;

export type InspectDeviceRuntimeFacts = (
  device: DeviceInfo,
) => Promise<RuntimeFacts<PlatformRuntimeOperations>>;

export type RequestRuntimeBindings = AsyncDisposable &
  Readonly<{
    inspectFacts: InspectDeviceRuntimeFacts;
    bindDevice: BindDeviceRuntime;
    bindExactDevice: BindExactDeviceRuntime;
  }>;

/**
 * Private broad-binding cache; handlers receive only the selected projection.
 *
 * `admitDeviceClaim` is the #1320 claim gate, and it runs as part of creating a
 * binding, so the per-device cache below is also what makes it run once per
 * device. Binding performs no device mutation — it composes the operation
 * catalog — so a binding that has not been admitted is the last state before any
 * device operation exists, and admitting here covers every handler by
 * construction. A refusal rejects the cached promise, so a second `bindDevice`
 * for the same device re-attempts rather than inheriting a rejected binding.
 */
export function createRequestRuntimeBindings(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  admitDeviceClaim: (device: DeviceInfo, owner: RuntimeOwnerRef) => Promise<void>;
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
    const key = deviceIdentityKey(deviceIdentity(device));
    let bindingPromise = bindings.get(key);
    if (!bindingPromise) {
      bindingPromise = params.gateway
        .bind({
          device,
          intent: { kind: 'ordinary' },
          scope: params.scope,
        })
        .then((binding) => cleanups.use(binding))
        .then(admitBinding);
      bindings.set(key, bindingPromise);
      void bindingPromise.catch(() => {
        if (bindings.get(key) === bindingPromise) bindings.delete(key);
      });
    }
    return narrowDeviceBinding(await bindingPromise, use);
  };

  // Exact-owner bindings deliberately bypass the cache, so they admit their own.
  const bindExactDevice: BindExactDeviceRuntime = async (device, owner, fence, use, scope) => {
    const published = await params.gateway.bind({
      device,
      intent: { kind: 'exact-owner', owner, fence },
      scope,
    });
    const binding = await admitBinding(await adoptExactBinding(cleanups, published, scope));
    return narrowDeviceBinding(binding, use);
  };

  return {
    inspectFacts: async (device) => await params.gateway.inspectFacts(device),
    bindDevice,
    bindExactDevice,
    [Symbol.asyncDispose]: async () => await cleanups[Symbol.asyncDispose](),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
