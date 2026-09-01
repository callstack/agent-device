import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import type {
  ReplaySessionMutationStore as ReplaySessionMutationStoreCapability,
  ReplaySessionStore as ReplaySessionStoreCapability,
} from '../../session-replay-coordinator.ts';

export type ReplaySessionStore = ReplaySessionStoreCapability;
export type ReplaySessionMutationStore = ReplaySessionMutationStoreCapability;
export type ReplaySessionObservationStore = Readonly<{
  get: () => SessionState | undefined;
  update: (mutate: (session: SessionState) => void) => boolean;
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
  observationStore: ReplaySessionObservationStore;
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
