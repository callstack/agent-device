import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';
import type { AgentDeviceClient } from '../../agent-device-client.ts';
import { isClientBackedCliCommandName, type ClientBackedCliCommandName } from './client-backed.ts';
import { connectCommand, connectionCommand, disconnectCommand } from './connection.ts';
import { authCommand } from './auth.ts';
import { proxyCommand } from './proxy.ts';
import { replayCommand } from './replay.ts';
import { screenshotCommand, diffCommand } from './screenshot.ts';
import type { ClientCommandHandlerMap, ClientCommandParams } from './router-types.ts';

export type {
  ClientCommandHandler,
  ClientCommandHandlerMap,
  ClientCommandParams,
} from './router-types.ts';

const dedicatedCliCommandHandlers = {
  connect: connectCommand,
  disconnect: disconnectCommand,
  connection: connectionCommand,
  auth: authCommand,
  proxy: proxyCommand,
  replay: replayCommand,
  screenshot: screenshotCommand,
  diff: diffCommand,
} satisfies ClientCommandHandlerMap;

export async function tryRunClientBackedCommand(params: {
  command: string;
  positionals: string[];
  flags: CliFlags;
  client: AgentDeviceClient;
  debug?: boolean;
  replayTestReporterRuntime?: ClientCommandParams['replayTestReporterRuntime'];
}): Promise<boolean> {
  const flags = { ...params.flags };
  const dedicatedHandler =
    dedicatedCliCommandHandlers[params.command as keyof typeof dedicatedCliCommandHandlers];
  if (dedicatedHandler) {
    const handled = await dedicatedHandler({ ...params, flags });
    if (handled) return true;
  }
  if (isClientBackedCliCommandName(params.command)) {
    return await runGenericClientBackedCommand({ ...params, command: params.command, flags });
  }
  return false;
}

async function runGenericClientBackedCommand(
  params: {
    command: ClientBackedCliCommandName;
  } & ClientCommandParams,
): Promise<boolean> {
  const { runGenericClientBackedCommand } = await import('./generic.ts');
  return await runGenericClientBackedCommand(params);
}
