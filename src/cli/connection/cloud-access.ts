import { createHash } from 'node:crypto';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  DEFAULT_CLOUD_BASE_URL,
  detectAuthMode,
  loginWithDeviceAuth,
  resolveCliSessionAccess,
} from '../auth-session.ts';
import { containsCloudCredential } from '../cloud-response.ts';
import { parseCloudOrigin } from '../cloud-origin.ts';
import { cloudApiKeyRequired, resolveBoundCloudApiKey } from './cloud-catalog-access.ts';

const CLOUD_ACCESS_REASONS = {
  // A hosted connection already records the API origin that owns its lease.
  savedOriginMismatch: { reason: 'cloud_origin_mismatch', commands: ['connect'] },
} as const satisfies ReasonTable<'cloud access'>;

export type HostedCloudAccess = {
  accessToken: string;
  cloudBaseUrl: string;
  accountBinding: string;
  credentials?: ReadonlySet<string>;
};

export function hostedCloudAccountBinding(access: HostedCloudAccess): string {
  return access.accountBinding;
}

function identityDigest(kind: string, value: string): string {
  return `${kind}:${createHash('sha256').update(value).digest('hex')}`;
}

export function matchesHostedCloudAccount(access: HostedCloudAccess, binding: string): boolean {
  const current = hostedCloudAccountBinding(access);
  return (
    current === binding ||
    (binding.startsWith('account:') &&
      current === identityDigest('account-sha256', binding.slice('account:'.length)))
  );
}

function bindHostedLogin(
  accountId: unknown,
  sessionId: unknown,
  credentials: ReadonlySet<string>,
): string {
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    containsCloudCredential([accountId, sessionId], [...credentials])
  ) {
    throw new AppError('UNAUTHORIZED', 'The hosted login did not return a valid identity.');
  }
  return typeof accountId === 'string' && accountId.trim()
    ? identityDigest('account-sha256', accountId)
    : identityDigest('login-sha256', sessionId);
}

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
  if (key) {
    return {
      accessToken: key,
      cloudBaseUrl,
      accountBinding: identityDigest('api-key', key),
    };
  }
  const flags = { json: false, help: false, version: false };
  const access = await readHostedLogin({ env: authEnv, stateDir, flags });
  if (access) {
    const credentials = new Set([access.accessToken, ...(access.catalogCredentials ?? [])]);
    return {
      accessToken: access.accessToken,
      accountBinding: bindHostedLogin(access.accountId, access.sessionId, credentials),
      cloudBaseUrl: parseCloudOrigin(access.cloudBaseUrl),
      credentials,
    };
  }
  if (!options.interactive || options.noLogin || detectAuthMode(authEnv) === 'non-interactive')
    throw cloudApiKeyRequired();
  const login = await loginWithDeviceAuth({
    env: authEnv,
    stateDir,
    flags,
    requiresLiveToken: true,
  });
  const credentials = new Set([login.accessToken, login.session.refreshCredential]);
  return {
    cloudBaseUrl: parseCloudOrigin(login.session.cloudBaseUrl),
    accessToken: login.accessToken,
    accountBinding: bindHostedLogin(login.session.accountId, login.session.id, credentials),
    credentials,
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
    return await resolveCliSessionAccess({ ...options, catalog: true });
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
