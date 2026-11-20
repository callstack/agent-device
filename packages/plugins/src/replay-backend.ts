import type { ReplayBackendPlugin } from '@agent-device/contracts/replay-backend';
import {
  NATIVE_REPLAY_BACKEND,
  type ReplayExecutionPlugin,
} from '@agent-device/contracts/replay-execution';
import type { ReplaySetupHost } from './host.ts';

/** A format backend's setup result: the lazy engine factory plus the registration's own cleanup. */
export type ReplayBackendSetup = Readonly<{
  replayBackend: ReplayBackendPlugin;
  dispose?(): Promise<void> | void;
}>;

/** Native replay's setup result: the lazy execution factory plus the registration's own cleanup. */
export type ReplayExecutionSetup = Readonly<{
  execution: ReplayExecutionPlugin;
  dispose?(): Promise<void> | void;
}>;

/**
 * A format replay engine contribution, such as Maestro. The host retains sessions, dispatch,
 * cancellation and cleanup; `replayBackend.create(host)` receives the full replay backend host
 * lazily, only when the backend is selected.
 */
export type ReplayBackendContribution<TBackend extends string = string> = Readonly<{
  kind: 'replay-backend';
  backend: TBackend;
  setup(host: ReplaySetupHost): Promise<ReplayBackendSetup> | ReplayBackendSetup;
}>;

/** The native `ad` replay and test execution contribution. */
export type ReplayExecutionContribution = Readonly<{
  kind: 'replay-execution';
  id: typeof NATIVE_REPLAY_BACKEND;
  setup(host: ReplaySetupHost): Promise<ReplayExecutionSetup> | ReplayExecutionSetup;
}>;

export type { ReplayBackendResolver } from '@agent-device/contracts/replay-backend';
