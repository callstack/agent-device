import type { JsonObject, JsonValue } from '@agent-device/contracts/client';
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
 * The completion properties a finished recording writes into its session manifest, and the key each
 * one lands on. The manifest outlives the request that produced it: a caller that stopped waiting
 * while the daemon was still exporting asks again with a later `record stop`, which reads these keys
 * back in `screen-recording-completion-metadata.ts`.
 *
 * The declaration lives here because session teardown reaches this module while it loads, and that
 * eager closure takes no new module (ADR-0019's loading-shape budget). Writing a completion is
 * property reads only; reading one needs the recording vocabulary and stays behind the stop path. The
 * mapped type obliges every completion property to name a key here, so a field cannot be added to the
 * stop response and left out of the manifest.
 */
export const screenRecordingCompletionFields = {
  backend: { key: 'backend', write: (c: ScreenRecordingCompletion) => c.backend },
  outPath: { key: 'outputPath', write: (c: ScreenRecordingCompletion) => c.outPath },
  startedAt: { key: 'startedAt', write: (c: ScreenRecordingCompletion) => c.startedAt },
  completedAt: { key: 'completedAt', write: (c: ScreenRecordingCompletion) => c.completedAt },
  scope: { key: 'scope', write: (c: ScreenRecordingCompletion) => c.scope },
  showTouches: { key: 'showTouches', write: (c: ScreenRecordingCompletion) => c.showTouches },
  recordOnlySession: {
    key: 'recordOnlySession',
    write: (c: ScreenRecordingCompletion) => c.recordOnlySession,
  },
  clientOutPath: {
    key: 'clientOutPath',
    write: (c: ScreenRecordingCompletion) => c.clientOutPath,
  },
  telemetryPath: {
    key: 'telemetryPath',
    write: (c: ScreenRecordingCompletion) => c.telemetryPath,
  },
  warning: { key: 'warning', write: (c: ScreenRecordingCompletion) => c.warning },
  overlayWarning: {
    key: 'overlayWarning',
    write: (c: ScreenRecordingCompletion) => c.overlayWarning,
  },
  activeSessionApp: {
    key: 'activeSessionApp',
    write: (c: ScreenRecordingCompletion) => encodeAppIdentity(c.activeSessionApp),
  },
  chunks: {
    key: 'chunks',
    write: (c: ScreenRecordingCompletion) => c.chunks?.map(encodeChunk),
  },
} satisfies {
  [K in keyof ScreenRecordingCompletion]: Readonly<{
    /** Key inside the durable manifest's completion metadata. */
    key: string;
    write: (completion: ScreenRecordingCompletion) => JsonValue | undefined;
  }>;
};

export function encodeScreenRecordingCompletionMetadata(
  completion: ScreenRecordingCompletion,
): JsonObject {
  const metadata: Record<string, JsonValue> = {};
  for (const field of Object.values(screenRecordingCompletionFields)) {
    const value = field.write(completion);
    if (value !== undefined) metadata[field.key] = value;
  }
  return metadata;
}

function encodeAppIdentity(app: RecordingAppIdentity | undefined): JsonValue | undefined {
  if (app === undefined) return undefined;
  return { bundleId: app.bundleId, ...(app.name === undefined ? {} : { name: app.name }) };
}

function encodeChunk(chunk: ScreenRecordingChunk): JsonValue {
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
