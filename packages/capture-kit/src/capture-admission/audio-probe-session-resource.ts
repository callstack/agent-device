import type {
  AudioProbeCompletion,
  AudioProbeLiveHandle,
} from '@agent-device/contracts/audio-probe-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DurableCaptureSessionStore } from '../durable-capture/index.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { DurableCaptureFinishIntent } from './durable-capture-resource.ts';
import type { AudioProbeAdmissionLedger } from './audio-probe-admission-ledger.ts';
import { audioProbeResourceStore } from './audio-probe-resource-store.ts';
import type { DurableCaptureSessionState } from './session-state-slice.ts';

export const audioProbeDurableResource = createDurableCaptureResource<
  'audio-probe',
  AudioProbeLiveHandle,
  AudioProbeCompletion,
  DurableCaptureSessionState
>({
  resourceKind: 'audio-probe',
  displayName: 'audio probe',
  store: audioProbeResourceStore,
  sessionSlot: {
    read: (session) => session.audioProbe,
    replace: (session, audioProbe) => ({ ...session, audioProbe }),
  },
  completionMetadata: (completion) => ({
    backend: completion.backend ?? 'unknown',
    source: completion.source,
    durationMs: completion.durationMs,
    elapsedMs: completion.elapsedMs,
    bucketMs: completion.bucketMs,
    sampleCount: completion.sampleCount,
    heard: completion.heard,
  }),
  failedFinishPolicy: 'dispose-on-failed-finish',
  messages: {
    noActive: 'no active audio probe',
    cleanupPendingHint:
      'Keep audio-probe.resource.json and retry stop through its exact runtime owner.',
  },
});

export function adoptStartedAudioProbe(params: {
  admissionLedger: AudioProbeAdmissionLedger;
  session: DurableCaptureSessionState;
  sessionName: string;
  sessionStore: DurableCaptureSessionStore<DurableCaptureSessionState>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<AudioProbeLiveHandle>;
  envelope: DurableResourceEnvelope<'audio-probe'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return audioProbeDurableResource.adoptStarted(params);
}

export function finishLiveAudioProbe(params: {
  session: DurableCaptureSessionState;
  sessionName: string;
  sessionStore: DurableCaptureSessionStore<DurableCaptureSessionState>;
  intent: DurableCaptureFinishIntent;
}): Promise<AudioProbeCompletion> {
  return audioProbeDurableResource.finishLive(params);
}
