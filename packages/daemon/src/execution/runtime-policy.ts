import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createDaemonTempFile, createUnsupportedArtifactAdapter } from './runtime-artifacts.ts';

export function createDaemonRuntimePolicy(
  unsupportedArtifactLabel: string,
  options: { plural?: boolean; allowTempFiles?: boolean } = {},
): Pick<AgentDeviceRuntimeConfig, 'artifacts' | 'policy'> {
  return {
    artifacts: options.allowTempFiles
      ? {
          ...createUnsupportedArtifactAdapter(unsupportedArtifactLabel, options),
          createTempFile: createDaemonTempFile,
        }
      : createUnsupportedArtifactAdapter(unsupportedArtifactLabel, options),
    policy: localCommandPolicy(),
  };
}
