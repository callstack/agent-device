import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { CliFlags } from '@agent-device/contracts/command';
import type { LeaseDevice } from '@agent-device/contracts/client';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import type { CliCommandName } from '@agent-device/command-registry/catalog';
import type { CommandProgressState } from '@agent-device/command-output';
import type { ReplayTestReporterRuntime } from '../replay-test/reporting.ts';

export type ClientCommandParams = {
  /** The host this run reads its environment and working directory from. */
  host: HostEnvironment;
  positionals: string[];
  flags: CliFlags;
  explicitDaemonAuthToken?: string;
  client: AgentDeviceClient;
  debug?: boolean;
  replayTestReporterRuntime?: ReplayTestReporterRuntime;
  /** Progress this run's transport already rendered to stderr, read by the output formatters. */
  commandProgress?: CommandProgressState;
  /** The device a proxy backend granted for the lease's device spec; `open` reports it. */
  leaseDevice?: LeaseDevice;
  /** The record `disconnect` claimed before its client was built, or `null` when it claimed none. */
  claimedConnection?: RemoteConnectionState | null;
};

/**
 * Returns true after producing command output. Returning false means the handler
 * intentionally produced no output and declined so the router can try the generic route.
 */
export type ClientCommandHandler = (params: ClientCommandParams) => Promise<boolean>;
export type ClientCommandHandlerMap = Partial<
  Record<CliCommandName, () => Promise<ClientCommandHandler>>
>;
