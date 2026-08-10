import {
  PendingTransferGuard,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type AppLogProcessMarkerReadOutcome,
  type AppLogRuntimeOperations,
  type AppLogStartResult,
  type CleanupOutcome,
  type DurableDescriptorCodec,
  type DurableResourceEnvelope,
  type ReattachOutcome,
  type ResourceOwnershipFence,
} from '@agent-device/contracts/platform';
import { decodeDurableDescriptor } from './durable-descriptor-codec.ts';

const APP_LOG_RESOURCE_KIND = 'app-log' as const;

export function createAppLogStartResult(
  handle: AppLogLiveHandle,
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>,
): AppLogStartResult {
  return Object.freeze({ pendingHandle: new PendingTransferGuard(handle), envelope });
}

type AppLogRecoveryContext = Readonly<{
  sessionId: string;
  fence: ResourceOwnershipFence;
}>;

export function createAppLogRecoveryOperations<Descriptor extends object>(implementation: {
  codec: DurableDescriptorCodec<Descriptor, typeof APP_LOG_RESOURCE_KIND>;
  reattach(
    descriptor: Descriptor,
    context: AppLogRecoveryContext,
  ): Promise<ReattachOutcome<AppLogLiveHandle, AppLogCompletion>>;
  cleanup(descriptor: Descriptor, context: AppLogRecoveryContext): Promise<CleanupOutcome>;
}): Pick<AppLogRuntimeOperations, 'appLogReattach' | 'appLogCleanup'> {
  return Object.freeze({
    appLogReattach: async ({ envelope }) => {
      const decoded = decodeDurableDescriptor(envelope, implementation.codec);
      if (decoded.status === 'unreattachable') return decoded;
      return await implementation.reattach(decoded.descriptor, recoveryContext(envelope));
    },
    appLogCleanup: async ({ envelope }) => {
      const decoded = decodeDurableDescriptor(envelope, implementation.codec);
      if (decoded.status === 'decoded') {
        return await implementation.cleanup(decoded.descriptor, recoveryContext(envelope));
      }
      return {
        status: 'cleanup-pending',
        reason: 'manual-recovery-required',
        message: decoded.message,
      };
    },
  });
}

function recoveryContext(
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>,
): AppLogRecoveryContext {
  return Object.freeze({ sessionId: envelope.sessionId, fence: envelope.fence });
}

/** Validates a present marker without collapsing corrupt or incomplete data into absence. */
export function decodeAppLogProcessMarker(value: unknown): AppLogProcessMarkerReadOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', message: 'App-log process marker must be an object' };
  }
  const marker = value as Record<string, unknown>;
  if (!Number.isInteger(marker.pid) || Number(marker.pid) <= 0) {
    return { status: 'invalid', message: 'App-log process marker pid must be a positive integer' };
  }
  if (typeof marker.startTime !== 'string' || marker.startTime.trim().length === 0) {
    return {
      status: 'invalid',
      message: 'App-log process marker startTime must be a non-empty string',
    };
  }
  if (typeof marker.command !== 'string' || marker.command.trim().length === 0) {
    return {
      status: 'invalid',
      message: 'App-log process marker command must be a non-empty string',
    };
  }
  return {
    status: 'decoded',
    marker: Object.freeze({
      pid: Number(marker.pid),
      startTime: marker.startTime,
      command: marker.command,
    }),
  };
}
