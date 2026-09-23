import {
  NO_PLATFORM_EXECUTION,
  ownerFilesEnabled,
  REQUEST_EXECUTION_EXEMPT,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import { audioRuntimePlanUses } from '@agent-device/contracts/audio-runtime-plan';
import { appLogRuntimePlanUses } from '@agent-device/contracts/logs-runtime-plan';
import { networkDumpUse } from '@agent-device/contracts/network-runtime-plan';
import { perfRuntimePlanUses } from '@agent-device/contracts/platform-runtime-operations';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The observability family (`src/commands/observability/**`, `src/commands/perf/**`): reads that
 * report on the app or device from outside it, and declare an observing recording effect.
 */
export const OBSERVABILITY_COMMAND_DESCRIPTORS = [
  {
    name: 'perf',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/perf/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: perfRuntimePlanUses },
  },
  {
    name: 'logs',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    platformExecution: { kind: 'device-runtime', uses: appLogRuntimePlanUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'events',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
      allowInvalidRecording: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: `events` flushes and reads the session's own event log. It touches no
    // device at all, so it has no platform execution path to migrate.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'network',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    platformExecution: { kind: 'device-runtime', use: networkDumpUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'audio',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: audioRuntimePlanUses },
  },
] as const satisfies readonly RawCommandDescriptor[];
