import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { DEFAULT_CLOUD_BASE_URL, resolveCliSessionAccess } from '../auth-session.ts';
import { parseCloudOrigin } from '../cloud-origin.ts';

const CLOUD_CATALOG_REASONS = {
  // The configured cloud origin needs its own API key or CLI login.
  apiKeyRequired: { reason: 'cloud_api_key_required', commands: ['connect'] },
  // The catalog key and selected cloud API specify different origins.
  keyOriginMismatch: { reason: 'cloud_catalog_key_origin_mismatch', commands: ['connect'] },
} as const satisfies ReasonTable<'cloud catalog'>;

export async function resolveCloudCatalogAccess(options: {
  stateDir: string;
  env: EnvMap;
}): Promise<{
  accessToken: string;
  cloudBaseUrl: string;
  catalogCredentials?: ReadonlySet<string>;
}> {
  const { env, stateDir } = options;
  const cloudBaseUrl = parseCloudOrigin(
    env.AGENT_DEVICE_CLOUD_BASE_URL ?? DEFAULT_CLOUD_BASE_URL,
    'AGENT_DEVICE_CLOUD_BASE_URL',
  );
  const accessToken = env.AGENT_DEVICE_CLOUD_API_KEY?.trim();
  if (accessToken) {
    const issuer = parseCloudOrigin(
      env.AGENT_DEVICE_CLOUD_API_KEY_ORIGIN ?? DEFAULT_CLOUD_BASE_URL,
      'AGENT_DEVICE_CLOUD_API_KEY_ORIGIN',
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
  });
  if (!access) {
    throw new AppError('UNAUTHORIZED', 'A catalog API key or CLI login is required.', {
      reason: CLOUD_CATALOG_REASONS.apiKeyRequired.reason,
      hint: 'Run agent-device auth login or set AGENT_DEVICE_CLOUD_API_KEY for this catalog.',
    });
  }
  return { ...access, cloudBaseUrl: parseCloudOrigin(access.cloudBaseUrl) };
}
