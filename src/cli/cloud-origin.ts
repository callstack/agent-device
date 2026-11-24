import { isLoopbackUrlHostname } from '@agent-device/host-kit/transport';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

const CLOUD_ORIGIN_REASONS = {
  // The cloud API origin is not HTTPS or loopback HTTP, or includes user information.
  invalid: { reason: 'cloud_invalid_origin', commands: ['auth', 'connect'] },
} as const satisfies ReasonTable<'cloud auth'>;

type CloudOriginVariable = 'AGENT_DEVICE_CLOUD_BASE_URL' | 'AGENT_DEVICE_CLOUD_API_KEY_ORIGIN';

export function parseCloudOrigin(value: string, configured?: CloudOriginVariable): string {
  return parseCloudUrl(value, configured).origin;
}

export function parseCloudUrl(value: string, configured?: CloudOriginVariable): URL {
  const url = parseCloudEndpoint(value, 'https:', 'http:');
  if (url) return url;
  throw new AppError(
    'INVALID_ARGS',
    configured ? `Invalid ${configured}.` : 'Invalid saved cloud API origin.',
    {
      reason: CLOUD_ORIGIN_REASONS.invalid.reason,
      ...(configured ? {} : { hint: 'Run agent-device auth login to save a valid cloud origin.' }),
    },
  );
}

export function parseCloudEndpoint(
  value: string,
  ...[secure, plaintext]: ['https:', 'http:'] | ['wss:', 'ws:']
): URL | undefined {
  const url = URL.parse(value);
  if (!url || url.username || url.password) return undefined;
  if (url.protocol === secure) return url;
  if (url.protocol === plaintext && isLoopbackUrlHostname(url.hostname)) return url;
}
