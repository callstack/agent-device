import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type AppleAppLogDescriptor = Readonly<{
  transport: 'apple-log-stream' | 'coredevice-console';
  backend: 'ios-simulator' | 'ios-device' | 'macos';
  outputPath: string;
  pidPath?: string;
}>;

type AppleAppLogDescriptorDecode = DurableDescriptorCodec<
  AppleAppLogDescriptor,
  typeof APP_LOG_RESOURCE_KIND
>['decode'];

const decodeAppleAppLogDescriptor: AppleAppLogDescriptorDecode = (body) => {
  if (!isAppleLogTransport(body.transport)) return invalidAppleAppLogDescriptor();
  if (!isAppleLogBackend(body.backend)) return invalidAppleAppLogDescriptor();
  if (!isNonEmptyString(body.outputPath)) return invalidAppleAppLogDescriptor();
  if (!isOptionalNonEmptyString(body.pidPath)) return invalidAppleAppLogDescriptor();
  if (!transportSupportsBackend(body.transport, body.backend)) {
    return invalidAppleAppLogDescriptor();
  }
  return {
    status: 'decoded',
    descriptor: Object.freeze({
      transport: body.transport,
      backend: body.backend,
      outputPath: body.outputPath,
      ...(body.pidPath === undefined ? {} : { pidPath: body.pidPath }),
    }),
  };
};

export const appleAppLogDescriptorCodec: DurableDescriptorCodec<
  AppleAppLogDescriptor,
  typeof APP_LOG_RESOURCE_KIND
> = Object.freeze({
  resourceKind: APP_LOG_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: AppleAppLogDescriptor) => ({ ...descriptor }),
  decode: decodeAppleAppLogDescriptor,
});

function invalidAppleAppLogDescriptor() {
  return { status: 'invalid', message: 'Invalid Apple app-log descriptor' } as const;
}

function isAppleLogTransport(value: unknown): value is AppleAppLogDescriptor['transport'] {
  return value === 'apple-log-stream' || value === 'coredevice-console';
}

function isAppleLogBackend(value: unknown): value is AppleAppLogDescriptor['backend'] {
  return value === 'ios-simulator' || value === 'ios-device' || value === 'macos';
}

function transportSupportsBackend(
  transport: AppleAppLogDescriptor['transport'],
  backend: AppleAppLogDescriptor['backend'],
): boolean {
  return transport === 'coredevice-console' ? backend === 'ios-device' : backend !== 'ios-device';
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

export function createAppleAppLogEnvelope(input: {
  sessionId: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: { token: string; generation: number };
  descriptor: AppleAppLogDescriptor;
}): DurableResourceEnvelope<'app-log'> {
  if (!input.device.appleOs) {
    throw new TypeError('Apple app-log persistence requires an explicit appleOs identity');
  }
  return createDurableResourceEnvelope({
    resourceKind: APP_LOG_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: {
      id: input.device.id,
      family: 'apple',
      appleOs: input.device.appleOs,
      kind: input.device.kind,
      ...(input.device.target === undefined ? {} : { target: input.device.target }),
      ...(input.device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: input.device.iosPhysicalDeviceBackend }),
    },
    owner: input.owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(appleAppLogDescriptorCodec, input.descriptor),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
