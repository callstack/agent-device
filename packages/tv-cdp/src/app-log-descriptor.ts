import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';

type TvAppLogDescriptor = Readonly<{
  transport: string;
  tv: string;
  appBundleId: string;
  outputPath: string;
}>;

export function appLogDescriptorCodec(
  transport: string,
  label: string,
): DurableDescriptorCodec<TvAppLogDescriptor, typeof APP_LOG_RESOURCE_KIND> {
  return Object.freeze({
    resourceKind: APP_LOG_RESOURCE_KIND,
    version: 1,
    encode: (descriptor) => ({ ...descriptor }),
    decode: (body) =>
      body.transport === transport &&
      typeof body.tv === 'string' &&
      typeof body.appBundleId === 'string' &&
      typeof body.outputPath === 'string'
        ? {
            status: 'decoded',
            descriptor: {
              transport,
              tv: body.tv,
              appBundleId: body.appBundleId,
              outputPath: body.outputPath,
            },
          }
        : { status: 'invalid', message: `Invalid ${label} app-log descriptor` },
  });
}
