const CLOUD_ARTIFACT_KINDS = [
  'video',
  'appium-log',
  'device-log',
  'automation-log',
  'provider-session',
  'raw',
] as const;

export type CloudArtifactKind = (typeof CLOUD_ARTIFACT_KINDS)[number];

export type CloudArtifactAvailability = 'ready' | 'pending' | 'unavailable' | 'expired';

export type CloudArtifact = {
  provider: string;
  kind: CloudArtifactKind;
  name: string;
  url?: string;
  providerSessionId?: string;
  providerArtifactId?: string;
  contentType?: string;
  extension?: string;
  availability?: CloudArtifactAvailability;
  metadata?: Record<string, unknown>;
};

export type CloudArtifactsStatus = 'ready' | 'pending' | 'unavailable';

export type CloudArtifactsResult = {
  provider: string;
  status: CloudArtifactsStatus;
  cloudArtifacts: CloudArtifact[];
  providerSessionId?: string;
  message?: string;
};

export type DaemonArtifactInventoryEntry = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
};

export type DaemonArtifactsResult = {
  source: 'daemon';
  status: 'ready';
  artifacts: DaemonArtifactInventoryEntry[];
  message?: string;
};

export type AgentArtifactsResult = CloudArtifactsResult | DaemonArtifactsResult;

export type CloudArtifactsQuery = {
  provider?: string;
  leaseId?: string;
  providerSessionId?: string;
};

export type CloudProviderSessionResult = {
  provider?: string;
  providerSessionId?: string;
  cloudArtifacts?: CloudArtifactsResult;
} & Record<string, unknown>;

/**
 * Return undefined only when this provider implementation does not handle the query.
 * Return a CloudArtifactsResult with status "unavailable" when the provider handled the
 * query but artifact retrieval failed, and "pending" when artifacts are not finalized yet.
 */
export type CloudArtifactProvider = {
  listCloudArtifacts?: (query: CloudArtifactsQuery) => Promise<CloudArtifactsResult | undefined>;
};
