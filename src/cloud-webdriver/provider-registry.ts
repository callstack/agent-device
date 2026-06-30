import type { CloudArtifactsQuery, CloudArtifactsResult } from '../cloud-artifacts.ts';
import {
  findCloudWebDriverProviderDefinition,
  type DefaultCloudWebDriverArtifactEnv,
} from './provider-definitions.ts';

export type { DefaultCloudWebDriverArtifactEnv } from './provider-definitions.ts';

export async function listCloudWebDriverArtifactsFromEnv(
  query: CloudArtifactsQuery,
  env: DefaultCloudWebDriverArtifactEnv,
): Promise<CloudArtifactsResult | undefined> {
  if (!query.providerSessionId) return undefined;
  return await findCloudWebDriverProviderDefinition(query.provider)?.listArtifactsFromEnv(
    query.providerSessionId,
    env,
  );
}
