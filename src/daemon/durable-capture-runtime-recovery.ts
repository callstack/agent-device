import type {
  DeviceBinding,
  DeviceRuntimeGateway,
  DurableResourceEnvelope,
  PlatformRequestScope,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function acquireExactDurableCaptureRecoveryControl<K extends string, Control>(params: {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  envelope: DurableResourceEnvelope<K>;
  scope: PlatformRequestScope;
  create(binding: DeviceBinding<PlatformRuntimeOperations>): Control;
}): Promise<Control> {
  let binding: DeviceBinding<PlatformRuntimeOperations> | undefined;
  try {
    binding = await params.gateway.bind({
      device: deviceFromDurableResourceEnvelope(params.envelope),
      intent: {
        kind: 'exact-owner',
        owner: params.envelope.owner,
        fence: params.envelope.fence,
      },
      scope: params.scope,
    });
    params.scope.signal.throwIfAborted();
    return params.create(binding);
  } catch (error) {
    if (binding) await binding[Symbol.asyncDispose]();
    throw error;
  }
}

function deviceFromDurableResourceEnvelope<K extends string>(
  envelope: DurableResourceEnvelope<K>,
): DeviceInfo {
  return {
    platform: envelope.device.family,
    id: envelope.device.id,
    name: envelope.device.id,
    kind: envelope.device.kind,
    ...(envelope.device.target === undefined ? {} : { target: envelope.device.target }),
    ...(envelope.device.appleOs === undefined ? {} : { appleOs: envelope.device.appleOs }),
    ...(envelope.device.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: envelope.device.iosPhysicalDeviceBackend }),
  };
}
