import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureRecoveryControl } from './durable-capture-recovery-authority.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { ScreenRecordingAdmissionLedger } from './screen-recording-admission-ledger.ts';
import { screenRecordingResourceStore } from './screen-recording-resource-store.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

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
  completionMetadata: (completion) => ({
    backend: completion.backend,
    outputPath: completion.outPath,
    startedAt: completion.startedAt,
    completedAt: completion.completedAt,
    scope: completion.scope,
    showTouches: completion.showTouches,
    recordOnlySession: completion.recordOnlySession,
  }),
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
