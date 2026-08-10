import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type LimrunAppLogDescriptor = Readonly<{
  transport: 'limrun-log-poller';
  platform: 'ios' | 'android';
  leaseId: string;
  instanceId: string;
  appBundleId: string;
  outputPath: string;
}>;

export const limrunAppLogDescriptorCodec: DurableDescriptorCodec<
  LimrunAppLogDescriptor,
  typeof APP_LOG_RESOURCE_KIND
> = Object.freeze({
  resourceKind: APP_LOG_RESOURCE_KIND,
  version: 1,
  encode: (descriptor) => ({ ...descriptor }),
  decode: (body) => {
    if (
      body.transport !== 'limrun-log-poller' ||
      (body.platform !== 'ios' && body.platform !== 'android') ||
      !isNonEmptyString(body.leaseId) ||
      !isNonEmptyString(body.instanceId) ||
      !isNonEmptyString(body.appBundleId) ||
      !isNonEmptyString(body.outputPath)
    ) {
      return { status: 'invalid', message: 'Invalid Limrun app-log descriptor' };
    }
    return {
      status: 'decoded',
      descriptor: Object.freeze({
        transport: 'limrun-log-poller',
        platform: body.platform,
        leaseId: body.leaseId,
        instanceId: body.instanceId,
        appBundleId: body.appBundleId,
        outputPath: body.outputPath,
      }),
    };
  },
});

export function createLimrunAppLogEnvelope(input: {
  sessionId: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: { token: string; generation: number };
  descriptor: LimrunAppLogDescriptor;
}): DurableResourceEnvelope<'app-log'> {
  if (input.device.platform === 'apple' && !input.device.appleOs) {
    throw new TypeError('Limrun Apple app-log persistence requires an explicit appleOs identity');
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
    descriptor: encodeDurableDescriptor(limrunAppLogDescriptorCodec, input.descriptor),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
