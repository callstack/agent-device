import net from 'node:net';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { DEFAULT_CLOUD_BASE_URL, resolveCliSessionAccess } from '../auth-session.ts';

const CLOUD_CATALOG_REASONS = {
  // The cloud API origin is not HTTPS or loopback HTTP, or includes user information.
  apiOriginFormat: { reason: 'cloud_invalid_origin', commands: ['connect'] },
  // The configured cloud origin needs its own API key or CLI login.
  apiKeyRequired: { reason: 'cloud_api_key_required', commands: ['connect'] },
} as const satisfies ReasonTable<'cloud catalog'>;

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export async function resolveCloudCatalogAccess(options: {
  stateDir: string;
  env: EnvMap;
  explicitToken?: string;
}): Promise<{ accessToken: string; cloudBaseUrl: string }> {
  const { env, stateDir, explicitToken } = options;
  const configuredOrigin =
    env.AGENT_DEVICE_CLOUD_BASE_URL === undefined
      ? undefined
      : parseCloudApiOrigin(env.AGENT_DEVICE_CLOUD_BASE_URL);
  const accessToken = explicitToken?.trim() || env.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim();
  const cloudBaseUrl = configuredOrigin ?? DEFAULT_CLOUD_BASE_URL;
  if (accessToken) return catalogAccess(cloudBaseUrl, accessToken);
  const access = await resolveCliSessionAccess({
    env,
    stateDir,
    flags: { json: false, help: false, version: false },
    validateIssuer: parseCloudApiOrigin,
  });
  if (!access) throw cloudApiKeyRequired();
  return {
    cloudBaseUrl: parseCloudApiOrigin(access.cloudBaseUrl),
    accessToken: access.accessToken,
  };
}

function catalogAccess(cloudBaseUrl: string, accessToken: string) {
  if (
    cloudBaseUrl === DEFAULT_CLOUD_BASE_URL &&
    !/^adc_(?:live|cli)_[A-Za-z0-9_-]{43}$/i.test(accessToken)
  ) {
    throw cloudApiKeyRequired();
  }
  return { accessToken, cloudBaseUrl };
}

function cloudApiKeyRequired(): AppError {
  return new AppError('UNAUTHORIZED', 'A cloud API key or CLI login is required.', {
    reason: CLOUD_CATALOG_REASONS.apiKeyRequired.reason,
    hint: 'Run agent-device auth login or set AGENT_DEVICE_DAEMON_AUTH_TOKEN to your cloud API key.',
  });
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
