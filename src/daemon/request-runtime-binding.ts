import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import {
  AsyncCleanupStack,
  narrowDeviceBinding,
  type AppLogRuntimeOperations,
  type BoundDeviceRuntime,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRequestScope,
  type RuntimeOperationKey,
  type RuntimeUse,
} from '@agent-device/contracts/platform';

export type BindDeviceRuntime = <
  const Required extends readonly RuntimeOperationKey<AppLogRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<AppLogRuntimeOperations>,
    Required[number]
  >[],
>(
  device: DeviceInfo,
  use: RuntimeUse<AppLogRuntimeOperations, Required, Preferred>,
) => Promise<BoundDeviceRuntime<RuntimeUse<AppLogRuntimeOperations, Required, Preferred>>>;

export type RequestRuntimeBindings = AsyncDisposable &
  Readonly<{
    bindDevice: BindDeviceRuntime;
  }>;

/** Private broad-binding cache; handlers receive only the selected projection. */
export function createRequestRuntimeBindings(params: {
  gateway: DeviceRuntimeGateway<AppLogRuntimeOperations>;
  scope: PlatformRequestScope;
}): RequestRuntimeBindings {
  const cleanups = new AsyncCleanupStack();
  const bindings = new Map<string, Promise<DeviceBinding<AppLogRuntimeOperations>>>();

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

  return {
    bindDevice,
    [Symbol.asyncDispose]: async () => await cleanups[Symbol.asyncDispose](),
  };
}
