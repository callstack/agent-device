import type { ReplayObservationAuthorityBinder } from '@agent-device/contracts/replay';
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonInvokeFn, DaemonRequest } from '../../daemon-request.ts';
import type { SessionState } from '../../session-state.ts';
import type {
  ReplaySessionMutationStore as ReplaySessionMutationStoreCapability,
  ReplaySessionStore as ReplaySessionStoreCapability,
} from '../../session-replay-coordinator.ts';
import { type DaemonResponse } from '@agent-device/kernel/contracts';

export type ReplaySessionStore = ReplaySessionStoreCapability;
export type ReplaySessionMutationStore = ReplaySessionMutationStoreCapability;
/**
 * The replay side of the ref-publication owner: the operational capture it reads, and a binder for
 * the daemon-side authority that records a capture and publishes exactly its own projection. The
 * session-store pair the authority is drawn from stays in the daemon.
 */
export type ReplaySessionObservation = Readonly<{
  get: () => SessionState | undefined;
  bindAuthority: ReplayObservationAuthorityBinder;
}>;

export type ReplayTestSessionFactory = (sessionName: string, logPath: string) => ReplaySession;

export type ReplaySession = Readonly<{
  /** The effective SessionStore key selected by request binding. */
  name: string;
  logPath: string;
  store: ReplaySessionStore;
  /** Bound repair writes; replay internals never receive an unbound SessionStore setter. */
  mutationStore: ReplaySessionMutationStore;
  /** Bound observation writes used only by the existing ref-publication owner. */
  observationStore: ReplaySessionObservation;
}>;

export type ReplayCommand = Readonly<{
  request: DaemonRequest;
  session: ReplaySession;
  invoke: DaemonInvokeFn;
  tracePath?: string;
  onStep?: ReplayTestAttemptStepSink;
}>;

type ReplayRequestContext = Readonly<{
  token: DaemonRequest['token'];
  meta: DaemonRequest['meta'];
}>;

export type ReplayRecordVideoRequest = Readonly<
  { request: ReplayRequestContext; sessionName: string } & (
    | { phase: 'start'; outputPath: string }
    | { phase: 'stop' }
  )
>;

export type ReplayRecordVideo = (params: ReplayRecordVideoRequest) => Promise<DaemonResponse>;

export type ReplayTestVideoOwner = Readonly<{
  record: ReplayRecordVideo;
  throwIfCanceled: () => void;
}>;

type ReplayTestSessionCleanup = (sessionName: string) => Promise<void>;

export type ReplayTestCommand = ReplayCommand &
  Readonly<{
    createSession: ReplayTestSessionFactory;
    cleanupSession: ReplayTestSessionCleanup;
    video?: ReplayTestVideoOwner;
  }>;
