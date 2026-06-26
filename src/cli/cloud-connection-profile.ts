import type { RemoteConfigProfile } from '../remote-config-schema.ts';
import { profileToCliFlags } from '../utils/remote-config.ts';
import { AppError } from '../utils/errors.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';
import { resolveCloudAccessForConnect } from './auth-session.ts';
import { readCloudJsonResponse } from './cloud-response.ts';
import {
  resolveGeneratedRemoteConfigProfile,
  writeGeneratedRemoteConfig,
} from './generated-remote-config.ts';

const CONNECTION_PROFILE_PATH = '/api/control-plane/connection-profile';
const HTTP_TIMEOUT_MS = 15_000;

type CloudConnectionProfileResponse = {
  connection?: {
    remoteConfigProfile?: unknown;
  };
};

export async function resolveCloudConnectProfile(options: {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
  fetchImpl?: typeof fetch;
}): Promise<{ flags: CliFlags; remoteConfigPath: string }> {
  const auth = await resolveCloudAccessForConnect({
    stateDir: options.stateDir,
    flags: options.flags,
    env: options.env,
    io: {
      env: options.env,
      fetch: options.fetchImpl,
    },
  });
  const profile = await fetchConnectionProfile({
    cloudBaseUrl: auth.cloudBaseUrl,
    accessToken: auth.accessToken,
    fetchImpl: options.fetchImpl,
  });
  const remoteConfigPath = writeGeneratedRemoteConfig({
    stateDir: options.stateDir,
    provider: 'cloud',
    profile,
  });
  const remoteConfig = resolveGeneratedRemoteConfigProfile({
    configPath: remoteConfigPath,
    cwd: options.cwd,
    env: options.env,
    provider: 'Cloud',
  });
  return {
    flags: {
      ...profileToCliFlags(remoteConfig.profile),
      ...options.flags,
      remoteConfig: remoteConfig.resolvedPath,
      daemonAuthToken: auth.accessToken,
    },
    remoteConfigPath: remoteConfig.resolvedPath,
  };
}

async function fetchConnectionProfile(options: {
  cloudBaseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<RemoteConfigProfile> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(CONNECTION_PROFILE_PATH, options.cloudBaseUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${options.accessToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const parsed = await readCloudJsonResponse<unknown>(response, {
    invalidJsonMessage: `Cloud connection profile endpoint returned invalid JSON (${response.status}).`,
    rejectedMessage: 'Cloud connection profile endpoint rejected the request.',
  });
  return parseConnectionProfile(parsed);
}

function parseConnectionProfile(value: unknown): RemoteConfigProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('COMMAND_FAILED', 'Cloud connection profile response is invalid.');
  }
  const connection = (value as CloudConnectionProfileResponse).connection;
  if (!connection || typeof connection !== 'object') {
    throw new AppError('COMMAND_FAILED', 'Cloud connection profile response is missing profile.');
  }
  if (connection.remoteConfigProfile !== undefined) {
    return parseRemoteConfigProfile(connection.remoteConfigProfile);
  }
  throw new AppError(
    'COMMAND_FAILED',
    'Cloud connection profile did not include remoteConfigProfile.',
  );
}

function parseRemoteConfigProfile(value: unknown): RemoteConfigProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(
      'COMMAND_FAILED',
      'Cloud connection profile remoteConfigProfile is invalid.',
    );
  }
  if (Object.keys(value).length === 0) {
    throw new AppError('COMMAND_FAILED', 'Cloud connection profile remoteConfigProfile is empty.');
  }
  return value as RemoteConfigProfile;
}
