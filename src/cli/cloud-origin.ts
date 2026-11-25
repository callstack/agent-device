import net from 'node:net';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

const CLOUD_ORIGIN_REASONS = {
  // The cloud API origin is not HTTPS or loopback HTTP, or includes user information.
  invalid: { reason: 'cloud_invalid_origin', commands: ['auth', 'connect'] },
} as const satisfies ReasonTable<'cloud auth'>;

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

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
  if (url.protocol === plaintext && isLoopbackHostname(url.hostname)) return url;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const address = hostname.replace(/^\[(.*)\]$/, '$1');
  const family = net.isIP(address);
  return family !== 0 && LOOPBACK.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
