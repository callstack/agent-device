import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type HarmonyAppLogDescriptor = Readonly<{
  transport: 'harmony-hilog';
  outputPath: string;
  pidPath: string;
}>;

export const harmonyAppLogDescriptorCodec: DurableDescriptorCodec<
  HarmonyAppLogDescriptor,
  typeof APP_LOG_RESOURCE_KIND
> = Object.freeze({
  resourceKind: APP_LOG_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: HarmonyAppLogDescriptor) => ({ ...descriptor }),
  decode: (body) => {
    if (
      body.transport !== 'harmony-hilog' ||
      !isNonEmptyString(body.outputPath) ||
      !isNonEmptyString(body.pidPath)
    ) {
      return { status: 'invalid', message: 'Invalid HarmonyOS app-log descriptor' } as const;
    }
    return {
      status: 'decoded',
      descriptor: Object.freeze({
        transport: 'harmony-hilog',
        outputPath: body.outputPath,
        pidPath: body.pidPath,
      }),
    } as const;
  },
});

export function createHarmonyAppLogEnvelope(input: {
  sessionId: string;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: { token: string; generation: number };
  descriptor: HarmonyAppLogDescriptor;
}): DurableResourceEnvelope<'app-log'> {
  return createDurableResourceEnvelope({
    resourceKind: APP_LOG_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: {
      id: input.device.id,
      family: 'harmonyos',
      kind: input.device.kind,
      ...(input.device.target === undefined ? {} : { target: input.device.target }),
    },
    owner: input.owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(harmonyAppLogDescriptorCodec, input.descriptor),
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
