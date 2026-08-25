import type {
  AudioProbeCompletion,
  AudioProbeLiveHandle,
} from '@agent-device/contracts/audio-probe-runtime';
import type {
  DurableResourceEnvelope,
  PendingTransferGuard,
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { AudioProbeAdmissionLedger } from './audio-probe-admission-ledger.ts';
import { audioProbeResourceStore } from './audio-probe-resource-store.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

export const audioProbeDurableResource = createDurableCaptureResource<
  'audio-probe',
  AudioProbeLiveHandle,
  AudioProbeCompletion
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
  messages: {
    noActive: 'no active audio probe',
    cleanupPendingHint:
      'Keep audio-probe.resource.json and retry stop through its exact runtime owner.',
  },
});

export function adoptStartedAudioProbe(params: {
  admissionLedger: AudioProbeAdmissionLedger;
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
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
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<AudioProbeCompletion> {
  return audioProbeDurableResource.finishLive(params);
}
