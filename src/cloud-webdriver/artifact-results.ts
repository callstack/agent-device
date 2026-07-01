import type { CloudArtifact, CloudArtifactsResult } from '../cloud-artifacts.ts';

export function cloudArtifactsReadyOrPending(options: {
  provider: string;
  providerSessionId: string;
  artifacts: CloudArtifact[];
  pendingMessage: string;
}): CloudArtifactsResult {
  return {
    provider: options.provider,
    providerSessionId: options.providerSessionId,
    status: options.artifacts.length > 0 ? 'ready' : 'pending',
    cloudArtifacts: options.artifacts,
    ...(options.artifacts.length > 0 ? {} : { message: options.pendingMessage }),
  };
}

export function unavailableCloudArtifactsResult(options: {
  provider: string;
  providerSessionId: string;
  error: unknown;
}): CloudArtifactsResult {
  return {
    provider: options.provider,
    providerSessionId: options.providerSessionId,
    status: 'unavailable',
    cloudArtifacts: [],
    message: options.error instanceof Error ? options.error.message : String(options.error),
  };
}
