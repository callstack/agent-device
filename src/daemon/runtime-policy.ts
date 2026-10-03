import type { AgentDeviceRuntimeConfig } from '../runtime-contract.ts';
import { localCommandPolicy } from '../runtime-factory.ts';
import { createUnsupportedArtifactAdapter } from './runtime-artifacts.ts';

export function createDaemonRuntimePolicy(
  unsupportedArtifactLabel: string,
  options: { plural?: boolean } = {},
): Pick<AgentDeviceRuntimeConfig, 'artifacts' | 'policy'> {
  return {
    artifacts: createUnsupportedArtifactAdapter(unsupportedArtifactLabel, options),
    policy: localCommandPolicy(),
  };
}
