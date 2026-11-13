import type {
  ReplayBackend,
  ReplayBackendHost,
  ReplayBackendPlugin,
} from '@agent-device/contracts/replay-backend';
import type { ProviderPluginHost } from './host.ts';

/** A managed v2 replay engine. The host retains sessions, dispatch, cancellation and cleanup. */
export type ReplayEnginePlugin = Readonly<{
  apiVersion: 2;
  kind: 'replay-backend';
  backend: string;
  setup(host: ProviderPluginHost): Promise<ReplayEngineSetup> | ReplayEngineSetup;
}>;

export type ReplayEngineSetup = Readonly<{
  replayBackend: ReplayBackendPlugin;
  dispose?(): Promise<void> | void;
}>;

export type ReplayBackendResolver = (
  id: string,
  host: ReplayBackendHost,
  packageName?: string,
) => Promise<ReplayBackend>;
