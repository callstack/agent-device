import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../types.ts';
import type { ReplaySessionStore as ReplaySessionStoreCapability } from '../../session-replay-coordinator.ts';

export type ReplaySessionStore = ReplaySessionStoreCapability;

export type ReplaySession = Readonly<{
  /** The effective SessionStore key selected by request binding. */
  name: string;
  logPath: string;
  store: ReplaySessionStore;
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
    cleanupSession: ReplayTestSessionCleanup;
    video?: ReplayTestVideoOwner;
  }>;
