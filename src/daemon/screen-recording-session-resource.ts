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
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureRecoveryControl } from '@agent-device/capture-kit/durable-capture';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { ScreenRecordingAdmissionLedger } from './screen-recording-admission-ledger.ts';
import { screenRecordingResourceStore } from './screen-recording-resource-store.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './session-state.ts';

export const screenRecordingDurableResource = createDurableCaptureResource<
  'screen-recording',
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion
>({
  resourceKind: 'screen-recording',
  displayName: 'screen recording',
  store: screenRecordingResourceStore,
  sessionSlot: {
    read: (session) => session.screenRecording,
    replace: (session, screenRecording) => ({ ...session, screenRecording }),
  },
  completionMetadata: encodeScreenRecordingCompletionMetadata,
  messages: {
    noActive: 'no active recording',
    cleanupPendingHint:
      'Keep screen-recording.resource.json and retry stop through its exact runtime owner.',
  },
});

export function adoptStartedScreenRecording(params: {
  admissionLedger: ScreenRecordingAdmissionLedger;
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
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
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<ScreenRecordingCompletion> {
  return screenRecordingDurableResource.finishLive(params);
}

/**
 * The manifest key holding a finished recording's stop response. The completion is stored as the one
 * object `record stop` returned, so a replay cannot lose a field on its way through the manifest;
 * `screen-recording-stop-recovery.ts` reads it back and serves it.
 */
export const SCREEN_RECORDING_COMPLETION_METADATA_KEY = 'completion';

export function encodeScreenRecordingCompletionMetadata(
  completion: ScreenRecordingCompletion,
): JsonObject {
  return {
    [SCREEN_RECORDING_COMPLETION_METADATA_KEY]: {
      backend: completion.backend,
      outPath: completion.outPath,
      startedAt: completion.startedAt,
      completedAt: completion.completedAt,
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
