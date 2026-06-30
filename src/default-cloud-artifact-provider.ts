import type { CloudArtifactProvider } from './cloud-artifacts.ts';
import {
  listCloudWebDriverArtifactsFromEnv,
  type DefaultCloudWebDriverArtifactEnv,
} from './cloud-webdriver/provider-registry.ts';

export type DefaultCloudArtifactProviderEnv = DefaultCloudWebDriverArtifactEnv;

export function createDefaultCloudArtifactProvider(
  env: DefaultCloudArtifactProviderEnv = process.env,
): CloudArtifactProvider {
  return {
    listCloudArtifacts: async (query) => await listCloudWebDriverArtifactsFromEnv(query, env),
  };
}
