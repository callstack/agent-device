import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type AndroidAppLogDescriptor = Readonly<{
  transport: 'android-logcat-local' | 'android-logcat-transport-composed';
  outputPath: string;
  pidPath: string;
}>;

export const androidAppLogDescriptorCodec: DurableDescriptorCodec<
  AndroidAppLogDescriptor,
  typeof APP_LOG_RESOURCE_KIND
> = Object.freeze({
  resourceKind: APP_LOG_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: AndroidAppLogDescriptor) => ({ ...descriptor }),
  decode: (body) => {
    if (
      (body.transport !== 'android-logcat-local' &&
        body.transport !== 'android-logcat-transport-composed') ||
      !isNonEmptyString(body.outputPath) ||
      !isNonEmptyString(body.pidPath)
    ) {
      return { status: 'invalid', message: 'Invalid Android app-log descriptor' } as const;
    }
    return {
      status: 'decoded',
      descriptor: Object.freeze({
        transport: body.transport,
        outputPath: body.outputPath,
        pidPath: body.pidPath,
      }),
    } as const;
  },
});

export function createAndroidAppLogEnvelope(input: {
  sessionId: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: { token: string; generation: number };
  descriptor: AndroidAppLogDescriptor;
}): DurableResourceEnvelope<'app-log'> {
  const decoded = androidAppLogDescriptorCodec.decode(input.descriptor);
  if (decoded.status !== 'decoded') throw new TypeError(decoded.message);
  return createDurableResourceEnvelope({
    resourceKind: APP_LOG_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: {
      id: input.device.id,
      family: 'android',
      kind: input.device.kind,
      ...(input.device.target === undefined ? {} : { target: input.device.target }),
    },
    owner: input.owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(androidAppLogDescriptorCodec, decoded.descriptor),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
