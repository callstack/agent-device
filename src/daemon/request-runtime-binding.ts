import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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
import { ensureDeviceReady, type DeviceReadyOptions } from './device-ready.ts';
import type {
  ManagedRequestAdmission,
  ResolveManagedRequestLease,
} from './managed-device-allocation/request-admission.ts';

const managedReadiness = new WeakMap<BoundDeviceIdentity, () => Promise<void>>();

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

/**
 * The two request-scoped seams a caller threads down to whichever route finally admits a device
 * cell. It lives here, beside the two function types it is composed of, rather than beside the
 * admission entry point that consumes it: callers that only forward the seams (a deferred capture
 * handing them to a retry, say) would otherwise have to import the whole admission module and
 * close a type cycle through it.
 */
export type RuntimeAdmissionBindings = Readonly<{
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}>;

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

/** Confirms managed authority or runs local readiness after binding and claim admission. */
export async function ensureBoundDeviceReady(
  bound: BoundDeviceIdentity,
  options: DeviceReadyOptions = {},
): Promise<void> {
  switch (bound.owner.kind) {
    case 'provider-runtime':
      return;
    case 'managed-local': {
      const ready = managedReadiness.get(bound);
      if (ready) {
        await ready();
        return;
      }
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Managed-device readiness is unavailable until allocator confirmation.',
        { reason: 'managed-readiness-unavailable' },
      );
    }
    case 'local-family':
      await ensureDeviceReady(bound.device, options);
  }
}

export type RequestRuntimeBindings = AsyncDisposable &
  Readonly<{
    inspectFacts: InspectDeviceRuntimeFacts;
    bindDevice: BindDeviceRuntime;
    bindExactDevice: BindExactDeviceRuntime;
  }>;

/** Owns request runtime bindings while exposing only the requested operation projection. */
export function createRequestRuntimeBindings(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  scope: PlatformRequestScope;
  resolveManagedLease?: ResolveManagedRequestLease;
  admitDeviceClaim: (
    device: DeviceInfo,
    owner: RuntimeOwnerRef,
    intent: DeviceBindingIntent,
  ) => Promise<void>;
}): RequestRuntimeBindings {
  const cleanups = new AsyncCleanupStack();
  const managedLifetime = new AbortController();
  const bindings = new Map<string, Promise<DeviceBinding<PlatformRuntimeOperations>>>();

  const admitBinding = async (
    binding: DeviceBinding<PlatformRuntimeOperations>,
    intent: DeviceBindingIntent,
  ): Promise<DeviceBinding<PlatformRuntimeOperations>> => {
    await params.admitDeviceClaim(binding.device, binding.owner, intent);
    return binding;
  };

  const bindDevice: BindDeviceRuntime = async (device, use) => {
    const key = deviceIdentityKey(deviceIdentity(device));
    let bindingPromise = bindings.get(key);
    if (!bindingPromise) {
      const intent: DeviceBindingIntent = { kind: 'ordinary' };
      bindingPromise = params.gateway
        .bind({ device, intent, scope: params.scope })
        .then((binding) => cleanups.use(binding))
        .then((binding) => admitBinding(binding, intent));
      bindings.set(key, bindingPromise);
      void bindingPromise.catch(() => {
        if (bindings.get(key) === bindingPromise) bindings.delete(key);
      });
    }
    return narrowDeviceBinding(await bindingPromise, use);
  };

  const bindExactDevice: BindExactDeviceRuntime = async (device, owner, fence, use, scope) => {
    const intent: DeviceBindingIntent = { kind: 'exact-owner', owner, fence };
    let managed: ManagedRequestAdmission | undefined;
    if (owner.kind === 'managed-local') {
      const { createManagedRequestAdmission } =
        await import('./managed-device-allocation/request-admission.ts');
      managed = createManagedRequestAdmission({
        device,
        intent,
        scope,
        lifetime: managedLifetime.signal,
        resolve: params.resolveManagedLease,
      });
    }
    if (managed) await params.admitDeviceClaim(device, owner, intent);
    const published = managed
      ? await managed.bind(() => params.gateway.bind({ device, intent, scope: managed.scope }))
      : await params.gateway.bind({ device, intent, scope });
    const adopted = await adoptExactBinding(cleanups, published, scope);
    const binding = managed ? adopted : await admitBinding(adopted, intent);
    const bound = narrowDeviceBinding(binding, use);
    managed?.activate();
    if (managed) managedReadiness.set(bound, managed.ensureReady);
    return bound;
  };

  return {
    inspectFacts: async (device) => await params.gateway.inspectFacts(device),
    bindDevice,
    bindExactDevice,
    [Symbol.asyncDispose]: async () => {
      managedLifetime.abort();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
