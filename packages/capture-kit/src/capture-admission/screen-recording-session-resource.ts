import { AppError } from '@agent-device/kernel/errors';
import { canonicalJson } from '@agent-device/kernel/collections';
import { sameDeviceIdentity } from '@agent-device/kernel/device';
import { sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { withDurableCaptureResourceFence } from '../durable-capture/fence.ts';
import {
  createStopProgress,
  markCompletingDurableCapture,
  transitionFinishOutcome,
} from '../durable-capture/transitions.ts';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import type { RecordingAppIdentity } from '@agent-device/contracts/recording';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DurableCaptureRecoveryControl,
  DurableCaptureRecordDefinition,
  DurableCaptureSessionBinding,
} from '../durable-capture/index.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import { assertScreenRecordingVideoArtifacts } from '../screen-recording-artifacts.ts';
import type { DurableCaptureFinishIntent } from './durable-capture-resource.ts';
import type { ScreenRecordingAdmissionLedger } from './screen-recording-admission-ledger.ts';
import {
  SCREEN_RECORDING_COMPLETION_METADATA_KEY,
  SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY,
  SCREEN_RECORDING_PENDING_COMPLETION_BINDING_KEY,
  screenRecordingPendingCompletionBinding,
  screenRecordingResourceStore,
} from './screen-recording-resource-store.ts';

const screenRecordingDefinition: DurableCaptureRecordDefinition<
  'screen-recording',
  ScreenRecordingCompletion
> = {
  resourceKind: 'screen-recording',
  displayName: 'screen recording',
  store: screenRecordingResourceStore,
  completionMetadata: encodeScreenRecordingCompletionMetadata,
  validateCompletion: assertScreenRecordingVideoArtifacts,
  pendingCompletionMetadata: (completion, envelope): JsonObject => {
    const binding = screenRecordingPendingCompletionBinding(envelope, completion);
    return binding ? { [SCREEN_RECORDING_PENDING_COMPLETION_BINDING_KEY]: binding } : {};
  },
  // The manifest holds the whole stop response this kind wrote, so a caller that reaches the committed
  // record is served the same export the first stop was answered with. That answer is a cold path: the
  // record has to be read before anyone can be refused or served, so the reader is reached on demand
  // rather than added to what importing this kind evaluates.
  completionFromMetadata: async (metadata) =>
    (await import('./screen-recording-stop-recovery.ts')).readReplayableStoredCompletion(metadata),
  // ADR 0024 rule 6: the next stop re-collects the native artifact a failed export left behind, and
  // forced cleanup would delete exactly that. Disposal belongs to teardown and start rollback.
  failedFinishPolicy: 'preserve-retry-material',
  messages: {
    noActive: 'no active recording',
    cleanupPendingHint:
      'Keep screen-recording.resource.json and retry stop through its exact runtime owner.',
  },
};

export const screenRecordingDurableResource = createDurableCaptureResource<
  'screen-recording',
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion
>(screenRecordingDefinition);

export function adoptStartedScreenRecording(params: {
  admissionLedger: ScreenRecordingAdmissionLedger;
  binding: DurableCaptureSessionBinding<'screen-recording', ScreenRecordingLiveHandle>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<ScreenRecordingLiveHandle>;
  reportConfirmedStartRollback?(): void;
  envelope: DurableResourceEnvelope<'screen-recording'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return screenRecordingDurableResource.adoptStarted(params);
}

export function finishLiveScreenRecording(params: {
  binding: DurableCaptureSessionBinding<'screen-recording', ScreenRecordingLiveHandle>;
  intent: DurableCaptureFinishIntent;
  signal?: AbortSignal;
}): Promise<ScreenRecordingCompletion> {
  return screenRecordingDurableResource.finishLive(params);
}

export function encodeScreenRecordingCompletionMetadata(
  completion: ScreenRecordingCompletion,
): JsonObject {
  return {
    [SCREEN_RECORDING_COMPLETION_METADATA_KEY]: {
      backend: completion.backend,
      outPath: completion.outPath,
      startedAt: completion.startedAt,
      completedAt: completion.completedAt,
      ...(completion.capturedDurationMs === undefined
        ? {}
        : { capturedDurationMs: completion.capturedDurationMs }),
      ...(completion.stopObservation === undefined
        ? {}
        : { stopObservation: encodeStopObservation(completion.stopObservation) }),
      ...(completion.nativePathDisposition === undefined
        ? {}
        : { nativePathDisposition: completion.nativePathDisposition }),
      scope: completion.scope,
      showTouches: completion.showTouches,
      recordOnlySession: completion.recordOnlySession,
      ...(completion.clientOutPath === undefined
        ? {}
        : { clientOutPath: completion.clientOutPath }),
      ...(completion.telemetryPath === undefined
        ? {}
        : { telemetryPath: completion.telemetryPath }),
      ...(completion.warning === undefined ? {} : { warning: completion.warning }),
      ...(completion.overlayWarning === undefined
        ? {}
        : { overlayWarning: completion.overlayWarning }),
      ...(completion.activeSessionApp === undefined
        ? {}
        : { activeSessionApp: encodeAppIdentity(completion.activeSessionApp) }),
      ...(completion.chunks === undefined ? {} : { chunks: completion.chunks.map(encodeChunk) }),
    },
  };
}

function encodeAppIdentity(app: RecordingAppIdentity): JsonObject {
  return { bundleId: app.bundleId, ...(app.name === undefined ? {} : { name: app.name }) };
}

function encodeStopObservation(observation: StopObservation): JsonObject {
  return observation.recorder === 'confirmed'
    ? { recorder: observation.recorder }
    : { recorder: observation.recorder, why: observation.why };
}

function encodeChunk(chunk: ScreenRecordingChunk): JsonObject {
  return {
    index: chunk.index,
    path: chunk.path,
    ...(chunk.clientOutPath === undefined ? {} : { clientOutPath: chunk.clientOutPath }),
  };
}

export async function finishRecoveredScreenRecording(params: {
  resourcePath: string;
  scope: PlatformRequestScope;
  acquireControl(
    envelope: DurableResourceEnvelope<'screen-recording'>,
    scope: PlatformRequestScope,
  ): Promise<
    DurableCaptureRecoveryControl<
      'screen-recording',
      ScreenRecordingLiveHandle,
      ScreenRecordingCompletion
    >
  >;
  deadlineMs?: number;
}): Promise<ScreenRecordingCompletion> {
  const store = screenRecordingDurableResource.store;
  const record = store.read(params.resourcePath);
  if (record.status !== 'decoded' || record.envelope.lifecycle !== 'open')
    throw new AppError('INVALID_ARGS', 'no active recording');
  const expected = record.envelope;
  const currentAuthority = () => {
    const current = store.read(params.resourcePath);
    if (current.status !== 'decoded' || !sameRecordingAuthority(expected, current.envelope))
      throw recordingOwnershipLost();
    return current.envelope;
  };
  return await withDurableCaptureResourceFence({
    store,
    resourcePath: params.resourcePath,
    expected: expected.fence,
    onCompleted: async ({ envelope }) => {
      if (!sameRecordingAuthority(expected, envelope)) throw recordingOwnershipLost();
      const { readReplayableStoredCompletion } =
        await import('./screen-recording-stop-recovery.ts');
      const completion = readReplayableStoredCompletion(envelope.metadata);
      if (completion) return completion;
      throw new AppError('COMMAND_FAILED', 'Recording completion is unavailable', {
        reason: 'resource-missing',
      });
    },
    run: async (lease) => {
      if (!sameRecordingAuthority(expected, lease.envelope)) throw recordingOwnershipLost();
      const controller = new AbortController();
      const scope = {
        ...params.scope,
        signal: AbortSignal.any([params.scope.signal, controller.signal]),
      };
      const timer = setTimeout(() => controller.abort(), params.deadlineMs ?? 5000);
      timer.unref?.();
      let control: Awaited<ReturnType<typeof params.acquireControl>> | undefined;
      try {
        scope.signal.throwIfAborted();
        const { readPendingScreenRecordingCompletion } =
          await import('./screen-recording-stop-recovery.ts');
        let result: Awaited<ReturnType<NonNullable<typeof control>['reattach']>>;
        try {
          control = await params.acquireControl(lease.envelope, scope);
          result = await control.reattach(lease.envelope);
        } catch (error) {
          const preserved = !scope.signal.aborted
            ? readPendingScreenRecordingCompletion(currentAuthority())
            : undefined;
          if (preserved) return preserved;
          throw error;
        }
        clearTimeout(timer);
        scope.signal.throwIfAborted();
        const current = currentAuthority();
        if (result.status === 'unreattachable' || result.status === 'missing') {
          const preserved = readPendingScreenRecordingCompletion(current);
          if (preserved) return preserved;
        }
        if (result.status === 'unreattachable')
          throw new AppError('COMMAND_FAILED', result.message ?? 'Recording cannot be reattached', {
            reason: result.reason,
          });
        if (result.status === 'missing')
          throw new AppError('COMMAND_FAILED', 'Recording is missing', {
            reason: 'resource-missing',
          });
        if (result.status === 'completed') {
          transitionFinishOutcome(screenRecordingDefinition, lease, {
            status: 'completed',
            result: result.result,
            ...(result.cleanupPending ? { cleanupPending: result.cleanupPending } : {}),
          });
          return result.result;
        }
        try {
          markCompletingDurableCapture(lease);
          const finished = await result.handle.finish(createStopProgress(lease, scope.signal));
          currentAuthority();
          if (finished.status !== 'completed')
            throw new AppError('COMMAND_FAILED', finished.message ?? 'Recording stop is pending', {
              reason: finished.reason,
            });
          transitionFinishOutcome(screenRecordingDefinition, lease, finished);
          return finished.result;
        } finally {
          if (result.status === 'export') await result.handle[Symbol.asyncDispose]();
        }
      } finally {
        clearTimeout(timer);
        if (control) await control[Symbol.asyncDispose]();
      }
    },
  });
}

function sameRecordingAuthority(
  expected: DurableResourceEnvelope<'screen-recording'>,
  current: DurableResourceEnvelope<'screen-recording'>,
): boolean {
  return (
    current.sessionId === expected.sessionId &&
    sameDeviceIdentity(current.device, expected.device) &&
    sameRuntimeOwner(current.owner, expected.owner) &&
    current.fence.token === expected.fence.token &&
    current.fence.generation === expected.fence.generation &&
    current.metadata?.[SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY] ===
      expected.metadata?.[SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY] &&
    canonicalJson(current.descriptor) === canonicalJson(expected.descriptor)
  );
}

function recordingOwnershipLost(): AppError {
  return new AppError('COMMAND_FAILED', 'Recording owner changed', {
    reason: 'ownership-fence-lost',
  });
}
