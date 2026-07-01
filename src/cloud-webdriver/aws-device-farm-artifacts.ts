import type { CloudArtifact, CloudArtifactsResult } from '../cloud-artifacts.ts';
import type { AwsDeviceFarmClient } from './aws-device-farm.ts';
import { cloudArtifactsReadyOrPending } from './artifact-results.ts';

export type AwsDeviceFarmArtifactGroup = 'FILE' | 'LOG' | 'SCREENSHOT';

export type AwsDeviceFarmArtifact = {
  arn?: string;
  name?: string;
  type?: string;
  extension?: string;
  url?: string;
  metadata?: string;
};

export async function listAwsDeviceFarmCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  client: AwsDeviceFarmClient,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const groups = await Promise.all([
    client.listArtifacts(providerSessionId, 'FILE'),
    client.listArtifacts(providerSessionId, 'LOG'),
  ]);
  const artifacts = groups
    .flat()
    .flatMap((artifact) => mapAwsDeviceFarmArtifact(provider, providerSessionId, artifact));
  return cloudArtifactsReadyOrPending({
    provider,
    providerSessionId,
    artifacts,
    pendingMessage: 'AWS Device Farm artifacts are not ready yet.',
  });
}

export function readAwsArtifacts(value: unknown): AwsDeviceFarmArtifact[] {
  if (!value || typeof value !== 'object') return [];
  const artifacts = (value as { artifacts?: unknown }).artifacts;
  return Array.isArray(artifacts) ? (artifacts as AwsDeviceFarmArtifact[]) : [];
}

function mapAwsDeviceFarmArtifact(
  provider: string,
  providerSessionId: string,
  artifact: AwsDeviceFarmArtifact,
): CloudArtifact[] {
  const url = artifact.url;
  if (typeof url !== 'string' || url.length === 0) return [];
  return [
    {
      provider,
      providerSessionId,
      kind: awsCloudArtifactKind(artifact.type),
      name: artifact.name ?? artifact.type ?? 'AWS Device Farm artifact',
      url,
      providerArtifactId: artifact.arn,
      extension: artifact.extension,
      availability: 'ready',
      metadata: {
        awsType: artifact.type,
        ...(artifact.metadata ? { awsMetadata: artifact.metadata } : {}),
      },
    },
  ];
}

function awsCloudArtifactKind(type: string | undefined): CloudArtifact['kind'] {
  switch (type) {
    case 'VIDEO':
      return 'video';
    case 'APPIUM_SERVER_OUTPUT':
      return 'appium-log';
    case 'DEVICE_LOG':
      return 'device-log';
    case 'MESSAGE_LOG':
    case 'UNKNOWN':
      return 'automation-log';
    default:
      return 'raw';
  }
}
