import {
  isRecordingStartRequest,
  NO_PLATFORM_EXECUTION,
  ownerFilesEnabled,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import { screenRecordingRuntimePlanUses } from '@agent-device/contracts/screen-recording-runtime-plan';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The recording family (`src/commands/recording/**`): commands whose artifact is a session
 * recording or trace rather than one frame of UI.
 */
export const RECORDING_COMMAND_DESCRIPTORS = [
  {
    name: 'record',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/recording/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: {
      route: 'recordTrace',
      refFrameEffect: 'preserve',
      allowInvalidRecording: true,
      allowSessionlessDefaultDevice: isRecordingStartRequest,
    },
    platformExecution: { kind: 'device-runtime', uses: screenRecordingRuntimePlanUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'trace',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/recording/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'recordTrace', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
] as const satisfies readonly RawCommandDescriptor[];
