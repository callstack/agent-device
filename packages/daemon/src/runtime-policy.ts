import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
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
