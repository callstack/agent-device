import { AppError } from '@agent-device/kernel/errors';
import type { DaemonNetworkAccessPolicy, DaemonRequest } from '../types.ts';
import { DAEMON_HTTP_PUBLIC_NETWORK_ACCESS } from '../http-contract.ts';

export type HttpTrustPolicy = {
  networkAccess: DaemonNetworkAccessPolicy;
};

export function resolveHttpTrustPolicy(params: {
  authHookConfigured: boolean;
  networkAccessMarker?: string | string[];
}): HttpTrustPolicy {
  if (params.networkAccessMarker !== undefined) {
    if (params.networkAccessMarker !== DAEMON_HTTP_PUBLIC_NETWORK_ACCESS) {
      throw new AppError('INVALID_ARGS', 'Invalid daemon HTTP network access marker');
    }
    return { networkAccess: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS };
  }
  return { networkAccess: params.authHookConfigured ? 'public-only' : 'unrestricted' };
}

export function applyHttpTrustPolicy(
  request: DaemonRequest,
  policy: HttpTrustPolicy,
): DaemonRequest {
  if (policy.networkAccess !== 'public-only') return request;
  const source = request.meta?.installSource;
  const uploadedArtifactId = request.meta?.uploadedArtifactId;
  if (
    source?.kind === 'path' &&
    !(typeof uploadedArtifactId === 'string' && uploadedArtifactId.length > 0)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: path install sources are disabled on the remote HTTP surface',
    );
  }

  return {
    ...request,
    internal: {
      ...request.internal,
      networkAccess: policy.networkAccess,
    },
  };
}
