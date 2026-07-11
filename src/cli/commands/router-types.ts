import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';
import type { AgentDeviceClient } from '../../agent-device-client.ts';
import type { CliCommandName } from '../../command-catalog.ts';
import type { ReplayTestReporterRuntime } from '../../replay/test/reporting.ts';

export type ClientCommandParams = {
  positionals: string[];
  flags: CliFlags;
  client: AgentDeviceClient;
  debug?: boolean;
  replayTestReporterRuntime?: ReplayTestReporterRuntime;
};

/**
 * Returns true after producing command output. Returning false means the handler
 * intentionally produced no output and declined so the router can try the generic route.
 */
export type ClientCommandHandler = (params: ClientCommandParams) => Promise<boolean>;
export type ClientCommandHandlerMap = Partial<Record<CliCommandName, ClientCommandHandler>>;
