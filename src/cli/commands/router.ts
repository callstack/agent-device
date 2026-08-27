import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient } from '../../agent-device-client.ts';
import { isClientBackedCliCommandName, type ClientBackedCliCommandName } from './client-backed.ts';
import type { ClientCommandHandlerMap, ClientCommandParams } from './router-types.ts';

export type { ClientCommandParams } from './router-types.ts';

// Some dedicated handlers pull in sizeable dependency subtrees (e.g.
// replay.ts -> @agent-device/maestro), so they're loaded lazily, on demand,
// the same way runGenericClientBackedCommand lazy-loads generic.ts below.
const dedicatedCliCommandHandlerLoaders = {
  connect: async () => (await import('./connection.ts')).connectCommand,
  disconnect: async () => (await import('./connection.ts')).disconnectCommand,
  connection: async () => (await import('./connection.ts')).connectionCommand,
  auth: async () => (await import('./auth.ts')).authCommand,
  daemon: async () => (await import('./daemon.ts')).daemonCommand,
  device: async () => (await import('./device.ts')).deviceCommand,
  proxy: async () => (await import('./proxy.ts')).proxyCommand,
  takeover: async () => (await import('./takeover.ts')).takeoverCommand,
  replay: async () => (await import('./replay.ts')).replayCommand,
  screenshot: async () => (await import('./screenshot.ts')).screenshotCommand,
  diff: async () => (await import('./screenshot.ts')).diffCommand,
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
  const loadDedicatedHandler =
    dedicatedCliCommandHandlerLoaders[
      params.command as keyof typeof dedicatedCliCommandHandlerLoaders
    ];
  if (loadDedicatedHandler) {
    const dedicatedHandler = await loadDedicatedHandler();
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
