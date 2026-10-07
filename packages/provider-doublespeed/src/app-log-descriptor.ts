import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type DoublespeedAppLogDescriptor = Readonly<{
  transport: 'doublespeed-log-poller';
  leaseId: string;
  simulatorId: string;
  appBundleId: string;
  outputPath: string;
}>;

export const doublespeedAppLogDescriptorCodec: DurableDescriptorCodec<
  DoublespeedAppLogDescriptor,
  typeof APP_LOG_RESOURCE_KIND
> = Object.freeze({
  resourceKind: APP_LOG_RESOURCE_KIND,
  version: 1,
  encode: (descriptor) => ({ ...descriptor }),
  decode: (body) => {
    if (
      body.transport !== 'doublespeed-log-poller' ||
      !isNonEmptyString(body.leaseId) ||
      !isNonEmptyString(body.simulatorId) ||
      !isNonEmptyString(body.appBundleId) ||
      !isNonEmptyString(body.outputPath)
    ) {
      return { status: 'invalid', message: 'Invalid Doublespeed app-log descriptor' };
    }
    return {
      status: 'decoded',
      descriptor: Object.freeze({
        transport: 'doublespeed-log-poller',
        leaseId: body.leaseId,
        simulatorId: body.simulatorId,
        appBundleId: body.appBundleId,
        outputPath: body.outputPath,
      }),
    };
  },
});

export function createDoublespeedAppLogEnvelope(input: {
  sessionId: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: { token: string; generation: number };
  descriptor: DoublespeedAppLogDescriptor;
}): DurableResourceEnvelope<'app-log'> {
  if (input.device.platform === 'apple' && !input.device.appleOs) {
    throw new TypeError('Doublespeed app-log persistence requires an explicit appleOs identity');
  }
  return createDurableResourceEnvelope({
    resourceKind: APP_LOG_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: {
      id: input.device.id,
      family: input.device.platform,
      ...(input.device.appleOs === undefined ? {} : { appleOs: input.device.appleOs }),
      kind: input.device.kind,
      ...(input.device.target === undefined ? {} : { target: input.device.target }),
      ...(input.device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: input.device.iosPhysicalDeviceBackend }),
    },
    owner: input.owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(doublespeedAppLogDescriptorCodec, input.descriptor),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
