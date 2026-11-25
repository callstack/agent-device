import fs from 'node:fs';
import { errorMessage } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { outputFileIdentity } from '@agent-device/host-kit/file';
import type {
  DurableCaptureProgress,
  LiveResourceHandle,
} from '@agent-device/contracts/durable-resource';
import type { ScreenRecordingFinalization } from '@agent-device/contracts/recording-stop-progress';
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
  DurableCaptureSessionBinding,
} from '../durable-capture/index.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { DurableCaptureFinishIntent } from './durable-capture-resource.ts';
import type { ScreenRecordingAdmissionLedger } from './screen-recording-admission-ledger.ts';
import {
  SCREEN_RECORDING_COMPLETION_METADATA_KEY,
  screenRecordingResourceStore,
} from './screen-recording-resource-store.ts';

export const screenRecordingDurableResource = createDurableCaptureResource<
  'screen-recording',
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion
>({
  resourceKind: 'screen-recording',
  displayName: 'screen recording',
  store: screenRecordingResourceStore,
  completionMetadata: encodeScreenRecordingCompletionMetadata,
  finishLive: finishRecordingExport,
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
});

export function adoptStartedScreenRecording(params: {
  admissionLedger: ScreenRecordingAdmissionLedger;
  binding: DurableCaptureSessionBinding<'screen-recording', ScreenRecordingLiveHandle>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<ScreenRecordingLiveHandle>;
  envelope: DurableResourceEnvelope<'screen-recording'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return screenRecordingDurableResource.adoptStarted(params);
}

export function finishLiveScreenRecording(params: {
  binding: DurableCaptureSessionBinding<'screen-recording', ScreenRecordingLiveHandle>;
  intent: DurableCaptureFinishIntent;
  confirmedMissing?: () => boolean;
}): Promise<ScreenRecordingCompletion> {
  return screenRecordingDurableResource.finishLive(params);
}

type RecordingExportProof = Readonly<{ completedAt: number; identities: string[] }>;
const liveExportProofs = new WeakMap<
  LiveResourceHandle<ScreenRecordingCompletion>,
  RecordingExportProof | null
>();

async function finishRecordingExport(
  handle: LiveResourceHandle<ScreenRecordingCompletion>,
  progress: DurableCaptureProgress,
) {
  const reservedPath = progress.learned?.remoteCapturePath;
  if (typeof reservedPath !== 'string') return { outcome: await handle.finish(progress) };
  const [{ chunkPathAt }, { deriveRecordingTelemetryPath }, { readStopCheckpoints }] =
    await Promise.all([
      import('../recording/output-path.ts'),
      import('../recording/telemetry.ts'),
      import('../recording/stop-checkpoints.ts'),
    ]);
  if (readStopCheckpoints(progress.learned).exportPath && !liveExportProofs.has(handle)) {
    liveExportProofs.set(handle, null);
  }
  const rememberExport = (
    outPath: string,
    { chunks, telemetryPath }: ScreenRecordingFinalization,
  ) => {
    if (liveExportProofs.has(handle)) return;
    try {
      if (
        outPath !== reservedPath ||
        chunks?.some(
          (chunk, offset) =>
            chunk.index !== offset + 1 || chunk.path !== chunkPathAt(reservedPath, chunk.index),
        ) ||
        (telemetryPath !== undefined &&
          telemetryPath !== deriveRecordingTelemetryPath(reservedPath))
      ) {
        throw new Error('Recording export does not match its reservation.');
      }
      const files = [
        reservedPath,
        ...(chunks?.slice(1).map(({ path }) => path) ?? []),
        ...(telemetryPath ? [telemetryPath] : []),
      ];
      liveExportProofs.set(handle, {
        completedAt: Date.now(),
        identities: files.map((file) => {
          const stat = fs.lstatSync(file);
          if (!stat.isFile()) throw new Error('Recording export is not a regular file.');
          return outputFileIdentity(stat);
        }),
      });
    } catch (error) {
      liveExportProofs.set(handle, null);
      emitDiagnostic({
        level: 'warn',
        phase: 'screen_recording_export_proof_failed',
        data: { error: errorMessage(error) },
      });
    }
  };
  const outcome = await handle.finish({
    ...progress,
    record: (fact) => {
      const { exportPath, finalization } = readStopCheckpoints(fact);
      if (exportPath) rememberExport(exportPath, finalization ?? {});
      progress.record(fact);
    },
  });
  if (outcome.status !== 'completed' || outcome.alreadyCompleted) return { outcome };
  rememberExport(outcome.result.outPath, outcome.result);
  const proof = liveExportProofs.get(handle);
  return { outcome, ...(proof ? { metadata: { remoteCaptureExport: proof } } : {}) };
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

export function finishRecoveredScreenRecording(params: {
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
  return screenRecordingDurableResource.finishRecovered(params);
}
