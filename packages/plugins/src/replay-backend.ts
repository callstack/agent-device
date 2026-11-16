import type { ReplayBackendPlugin } from '@agent-device/contracts/replay-backend';
import type {
  NATIVE_REPLAY_BACKEND,
  ReplayExecutionPlugin,
} from '@agent-device/contracts/replay-execution';
import type { ProviderPluginHost } from './host.ts';

/** A managed v2 replay engine. The host retains sessions, dispatch, cancellation and cleanup. */
export type ReplayEnginePlugin<TBackend extends string = string> = Readonly<{
  apiVersion: 2;
  kind: 'replay-backend';
  backend: TBackend;
  setup(
    host: ProviderPluginHost,
  ): Promise<ReplayEngineSetup<TBackend>> | ReplayEngineSetup<TBackend>;
}>;

type NativeExecutionSetup = { execution: ReplayExecutionPlugin; replayBackend?: never };
type FormatBackendSetup = { replayBackend: ReplayBackendPlugin; execution?: never };

/** Native execution belongs to ad; other backend ids supply a format engine. */
export type ReplayEngineSetup<TBackend extends string = string> = Readonly<
  { dispose?(): Promise<void> | void } & (TBackend extends typeof NATIVE_REPLAY_BACKEND
    ? NativeExecutionSetup
    : string extends TBackend
      ? NativeExecutionSetup | FormatBackendSetup
      : FormatBackendSetup)
>;

export type { ReplayBackendResolver } from '@agent-device/contracts/replay-backend';
