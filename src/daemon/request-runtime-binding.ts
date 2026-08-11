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

export type RequestRuntimeBindings = AsyncDisposable &
  Readonly<{
    bindDevice: BindDeviceRuntime;
    bindExactDevice: BindExactDeviceRuntime;
  }>;

/** Private broad-binding cache; handlers receive only the selected projection. */
export function createRequestRuntimeBindings(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
}): RequestRuntimeBindings {
  const cleanups = new AsyncCleanupStack();
  const bindings = new Map<string, Promise<DeviceBinding<PlatformRuntimeOperations>>>();

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
        .then((binding) => cleanups.use(binding));
      bindings.set(key, bindingPromise);
      void bindingPromise.catch(() => {
        if (bindings.get(key) === bindingPromise) bindings.delete(key);
      });
    }
    const binding = await bindingPromise;
    return narrowDeviceBinding(binding, use);
  };

  const bindExactDevice: BindExactDeviceRuntime = async (device, owner, fence, use, scope) => {
    const published = await params.gateway.bind({
      device,
      intent: { kind: 'exact-owner', owner, fence },
      scope,
    });
    const binding = await adoptExactBinding(cleanups, published, scope);
    return narrowDeviceBinding(binding, use);
  };

  return {
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
