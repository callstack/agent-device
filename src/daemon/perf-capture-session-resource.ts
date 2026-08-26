import type {
  PerfNativeCaptureCompletion,
  PerfNativeCaptureLiveHandle,
} from '@agent-device/contracts/perf-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  ResourceOwnershipFence,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { PerfCaptureAdmissionLedger } from './perf-capture-admission-ledger.ts';
import { perfCaptureResourceStore } from './perf-capture-resource-store.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

export const perfCaptureDurableResource = createDurableCaptureResource<
  'perf-capture',
  PerfNativeCaptureLiveHandle,
  PerfNativeCaptureCompletion
>({
  resourceKind: 'perf-capture',
  displayName: 'perf capture',
  store: perfCaptureResourceStore,
  sessionSlot: {
    read: (session) => session.perfCapture,
    replace: (session, perfCapture) => ({ ...session, perfCapture }),
  },
  completionMetadata: (completion) => ({
    kind: typeof completion.kind === 'string' ? completion.kind : 'unknown',
    mode: typeof completion.mode === 'string' ? completion.mode : 'unknown',
    ...(typeof completion.outPath === 'string' ? { outPath: completion.outPath } : {}),
  }),
  messages: {
    noActive: 'no active native perf capture',
    cleanupPendingHint:
      'Keep perf-capture.resource.json and retry stop through its exact runtime owner.',
  },
});

export function adoptStartedPerfCapture(params: {
  admissionLedger: PerfCaptureAdmissionLedger;
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  fence: ResourceOwnershipFence;
  pendingHandle: PendingTransferGuard<PerfNativeCaptureLiveHandle>;
  envelope: DurableResourceEnvelope<'perf-capture'>;
  throwIfCanceled(): void;
}): Promise<void> {
  return perfCaptureDurableResource.adoptStarted(params);
}

export function finishLivePerfCapture(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<PerfNativeCaptureCompletion> {
  return perfCaptureDurableResource.finishLive(params);
}
