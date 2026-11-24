import net from 'node:net';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { DEFAULT_CLOUD_BASE_URL, resolveCliSessionAccess } from '../auth-session.ts';

const CLOUD_CATALOG_REASONS = {
  // The cloud API origin is not HTTPS or loopback HTTP, or includes user information.
  apiOriginFormat: { reason: 'cloud_invalid_origin', commands: ['connect'] },
  // The configured cloud origin needs its own API key or CLI login.
  apiKeyRequired: { reason: 'cloud_api_key_required', commands: ['connect'] },
  // The catalog key and selected cloud API specify different origins.
  keyOriginMismatch: { reason: 'cloud_catalog_key_origin_mismatch', commands: ['connect'] },
} as const satisfies ReasonTable<'cloud catalog'>;

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export async function resolveCloudCatalogAccess(options: {
  stateDir: string;
  env: EnvMap;
}): Promise<{
  accessToken: string;
  cloudBaseUrl: string;
  catalogCredentials?: ReadonlySet<string>;
}> {
  const { env, stateDir } = options;
  const cloudBaseUrl = parseCloudApiOrigin(
    env.AGENT_DEVICE_CLOUD_BASE_URL ?? DEFAULT_CLOUD_BASE_URL,
  );
  const accessToken = env.AGENT_DEVICE_CLOUD_API_KEY?.trim();
  if (accessToken) {
    const issuer = parseCloudApiOrigin(
      env.AGENT_DEVICE_CLOUD_API_KEY_ORIGIN ?? DEFAULT_CLOUD_BASE_URL,
    );
    if (issuer !== cloudBaseUrl) {
      throw new AppError(
        'UNAUTHORIZED',
        'The catalog API key belongs to another cloud API origin.',
        {
          reason: CLOUD_CATALOG_REASONS.keyOriginMismatch.reason,
        },
      );
    }
    return { accessToken, cloudBaseUrl };
  }
  const access = await resolveCliSessionAccess({
    env,
    stateDir,
    flags: { json: false, help: false, version: false },
    catalog: true,
    validateIssuer: parseCloudApiOrigin,
  });
  if (!access) {
    throw new AppError('UNAUTHORIZED', 'A catalog API key or CLI login is required.', {
      reason: CLOUD_CATALOG_REASONS.apiKeyRequired.reason,
      hint: 'Run agent-device auth login or set AGENT_DEVICE_CLOUD_API_KEY for this catalog.',
    });
  }
  return { ...access, cloudBaseUrl: parseCloudApiOrigin(access.cloudBaseUrl) };
}

function parseCloudApiOrigin(value: string): string {
  const url = URL.parse(value);
  if (
    url &&
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname)))
  ) {
    return url.origin;
  }
  throw new AppError('INVALID_ARGS', 'Invalid cloud session API origin.', {
    reason: CLOUD_CATALOG_REASONS.apiOriginFormat.reason,
  });
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const address = hostname.replace(/^\[(.*)\]$/, '$1');
  const family = net.isIP(address);
  return family !== 0 && LOOPBACK.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
