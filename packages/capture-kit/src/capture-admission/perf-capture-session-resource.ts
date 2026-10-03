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
import type { DurableCaptureSessionStore } from '../durable-capture/index.ts';
import { createDurableCaptureResource } from './durable-capture-resource.ts';
import type { DurableCaptureFinishIntent } from './durable-capture-resource.ts';
import type { PerfCaptureAdmissionLedger } from './perf-capture-admission-ledger.ts';
import { perfCaptureResourceStore } from './perf-capture-resource-store.ts';
import type { DurableCaptureSessionState } from './session-state-slice.ts';

export const perfCaptureDurableResource = createDurableCaptureResource<
  'perf-capture',
  PerfNativeCaptureLiveHandle,
  PerfNativeCaptureCompletion,
  DurableCaptureSessionState
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
  // ADR 0024 rule 6: a stop that could not pull its trace leaves the profiler artifact where the
  // next `perf stop` looks, and this kind's forced cleanup removes exactly that path.
  failedFinishPolicy: 'preserve-retry-material',
  messages: {
    noActive: 'no active native perf capture',
    cleanupPendingHint:
      'Keep perf-capture.resource.json and retry stop through its exact runtime owner.',
  },
});

export function adoptStartedPerfCapture(params: {
  admissionLedger: PerfCaptureAdmissionLedger;
  session: DurableCaptureSessionState;
  sessionName: string;
  sessionStore: DurableCaptureSessionStore<DurableCaptureSessionState>;
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
  session: DurableCaptureSessionState;
  sessionName: string;
  sessionStore: DurableCaptureSessionStore<DurableCaptureSessionState>;
  intent: DurableCaptureFinishIntent;
}): Promise<PerfNativeCaptureCompletion> {
  return perfCaptureDurableResource.finishLive(params);
}
