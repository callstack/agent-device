import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonNetworkAccessPolicy, DaemonRequest } from '../types.ts';
import { expandUserHomePath } from '@agent-device/host-kit/file';
import { isEnvTruthy } from '@agent-device/host-kit/retry';

export const HTTP_ALLOW_HOST_PATH_INSTALL_ENV = 'AGENT_DEVICE_HTTP_ALLOW_HOST_PATH_INSTALL';
export const HTTP_HOST_PATH_INSTALL_ROOT_ENV = 'AGENT_DEVICE_HTTP_HOST_PATH_INSTALL_ROOT';

export type HttpTrustPolicy = {
  networkAccess: DaemonNetworkAccessPolicy;
  hostPathInstallRoot?: string;
};

export async function resolveHttpTrustPolicy(params: {
  authHookConfigured: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<HttpTrustPolicy> {
  if (!params.authHookConfigured) return { networkAccess: 'unrestricted' };
  if (!isEnvTruthy(params.env[HTTP_ALLOW_HOST_PATH_INSTALL_ENV])) {
    return { networkAccess: 'public-only' };
  }

  const rawRoot = (params.env[HTTP_HOST_PATH_INSTALL_ROOT_ENV] ?? '').trim();
  if (!rawRoot) {
    throw new AppError(
      'INVALID_ARGS',
      `${HTTP_ALLOW_HOST_PATH_INSTALL_ENV} requires ${HTTP_HOST_PATH_INSTALL_ROOT_ENV}`,
    );
  }
  const configuredRoot = path.resolve(expandUserHomePath(rawRoot, { env: params.env }));
  let root: string;
  try {
    root = await fs.realpath(configuredRoot);
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `${HTTP_HOST_PATH_INSTALL_ROOT_ENV} must name an existing directory: ${configuredRoot}`,
      { root: configuredRoot },
      error,
    );
  }
  return { networkAccess: 'public-only', hostPathInstallRoot: root };
}

export async function confineHttpInstallSourcePath(rawPath: string, root: string): Promise<string> {
  const candidate = path.resolve(expandUserHomePath(rawPath));
  let resolved: string;
  try {
    resolved = await fs.realpath(candidate);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source.path must name an existing path below the approved root',
      { root },
      error,
    );
  }
  const relative = path.relative(root, resolved);
  if (
    relative !== '' &&
    (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source.path resolves outside the approved root',
      { root },
    );
  }
  return resolved;
}

export async function applyHttpInstallSourceTrustPolicy(
  request: DaemonRequest,
  policy: HttpTrustPolicy,
): Promise<DaemonRequest> {
  if (policy.networkAccess !== 'public-only') return request;
  const source = request.meta?.installSource;
  if (!source || source.kind !== 'path') return request;

  const uploadedArtifactId = request.meta?.uploadedArtifactId;
  if (typeof uploadedArtifactId === 'string' && uploadedArtifactId.length > 0) return request;
  if (!policy.hostPathInstallRoot) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid params: path install sources are disabled on the remote HTTP surface; set ${HTTP_ALLOW_HOST_PATH_INSTALL_ENV}=true and ${HTTP_HOST_PATH_INSTALL_ROOT_ENV} to opt in`,
    );
  }
  return {
    ...request,
    meta: {
      ...request.meta,
      installSource: {
        kind: 'path',
        path: await confineHttpInstallSourcePath(source.path, policy.hostPathInstallRoot),
      },
    },
  };
}
