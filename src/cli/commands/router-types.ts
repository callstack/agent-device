import type { CliFlags } from '../../utils/cli-flags.ts';
import type { AgentDeviceClient } from '../../client.ts';
import type { CliCommandName } from '../../command-catalog.ts';

export type ClientCommandParams = {
  positionals: string[];
  flags: CliFlags;
  client: AgentDeviceClient;
  debug?: boolean;
};

/**
 * Returns true after producing command output. Returning false means the handler
 * intentionally produced no output and declined so the router can try the generic route.
 */
export type ClientCommandHandler = (params: ClientCommandParams) => Promise<boolean>;
export type ClientCommandHandlerMap = Partial<Record<CliCommandName, ClientCommandHandler>>;
