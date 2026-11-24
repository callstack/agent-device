import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  DEFAULT_CLOUD_BASE_URL,
  detectAuthMode,
  loginWithDeviceAuth,
  resolveCliSessionAccess,
} from '../auth-session.ts';
import { parseCloudOrigin } from '../cloud-origin.ts';
import { cloudApiKeyRequired, resolveBoundCloudApiKey } from './cloud-catalog-access.ts';

const CLOUD_ACCESS_REASONS = {
  // A hosted connection already records the API origin that owns its lease.
  savedOriginMismatch: { reason: 'cloud_origin_mismatch', commands: ['connect'] },
} as const satisfies ReasonTable<'cloud access'>;

export type HostedCloudAccess = { accessToken: string; cloudBaseUrl: string };

export async function resolveHostedCloudAccess(options: {
  stateDir: string;
  env: EnvMap;
  noLogin?: boolean;
  savedOrigin?: string;
  interactive?: boolean;
}): Promise<HostedCloudAccess> {
  const { env, stateDir, savedOrigin } = options;
  const { cloudBaseUrl, authEnv } = resolveHostedOrigin(env, savedOrigin);
  const key = resolveBoundCloudApiKey(env, cloudBaseUrl, hostedOriginMismatch);
  if (key) return { accessToken: key, cloudBaseUrl };
  const flags = { json: false, help: false, version: false };
  const access = await readHostedLogin({ env: authEnv, stateDir, flags });
  const accessToken = access?.accessToken.trim();
  if (access && accessToken)
    return {
      accessToken,
      cloudBaseUrl: parseCloudOrigin(access.cloudBaseUrl),
    };
  if (!options.interactive || options.noLogin || detectAuthMode(authEnv) === 'non-interactive')
    throw cloudApiKeyRequired();
  const login = await loginWithDeviceAuth({
    env: authEnv,
    stateDir,
    flags,
    requiresLiveToken: true,
  });
  return {
    cloudBaseUrl: parseCloudOrigin(login.session.cloudBaseUrl),
    accessToken: login.accessToken.trim(),
  };
}

function resolveHostedOrigin(env: EnvMap, savedOrigin: string | undefined) {
  const configured = env.AGENT_DEVICE_CLOUD_BASE_URL;
  const configuredOrigin =
    configured === undefined
      ? undefined
      : parseCloudOrigin(configured, 'AGENT_DEVICE_CLOUD_BASE_URL');
  const pinnedOrigin = savedOrigin === undefined ? undefined : parseCloudOrigin(savedOrigin);
  if (pinnedOrigin && configuredOrigin) assertSameHostedOrigin(configuredOrigin, pinnedOrigin);
  return {
    cloudBaseUrl: pinnedOrigin ?? configuredOrigin ?? DEFAULT_CLOUD_BASE_URL,
    authEnv: pinnedOrigin ? { ...env, AGENT_DEVICE_CLOUD_BASE_URL: pinnedOrigin } : env,
  };
}

async function readHostedLogin(options: Parameters<typeof resolveCliSessionAccess>[0]) {
  try {
    return await resolveCliSessionAccess(options);
  } catch (error) {
    if (error instanceof AppError && error.code === 'UNAUTHORIZED') {
      throw new AppError(error.code, error.message, {
        ...error.details,
        hint: cloudApiKeyRequired().details?.hint,
      });
    }
    throw error;
  }
}

function assertSameHostedOrigin(configured: string, saved: string): void {
  if (configured === saved) return;
  throw hostedOriginMismatch();
}

function hostedOriginMismatch(): AppError {
  return new AppError(
    'INVALID_ARGS',
    'Cloud API origin differs from the credential or saved connection.',
    {
      reason: CLOUD_ACCESS_REASONS.savedOriginMismatch.reason,
    },
  );
}
