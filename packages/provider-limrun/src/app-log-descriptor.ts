import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import type { LimrunInstanceOwnership } from './instance-access.ts';

export type LimrunAppLogDescriptor = Readonly<{
  transport: 'limrun-log-poller';
  platform: 'ios' | 'android';
  leaseId: string;
  instanceId: string;
  ownership: LimrunInstanceOwnership;
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
    const ownership = decodeOwnership(body.ownership);
    if (
      !ownership ||
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
        ownership,
        appBundleId: body.appBundleId,
        outputPath: body.outputPath,
      }),
    };
  },
});

/** Descriptors written before attach support carry no ownership; those named created instances. */
function decodeOwnership(value: unknown): LimrunInstanceOwnership | undefined {
  if (value === undefined) return 'created';
  return value === 'created' || value === 'attached' ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
