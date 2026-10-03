import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';

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

/** A ready URL artifact read off a provider's session-details record, or nothing when the field is absent. */
export function urlArtifactFromDetails(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
  field: string,
  kind: CloudArtifact['kind'],
  name: string,
): CloudArtifact | undefined {
  const value = details[field];
  const url = typeof value === 'string' ? value.trim() : '';
  if (url.length === 0) return undefined;
  return { provider, providerSessionId, kind, name, url, availability: 'ready' };
}
