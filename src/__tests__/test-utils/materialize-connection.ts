import type { FlagKey } from '@agent-device/command-registry/flag-types';
import {
  materializeRemoteConnectionForCommand as materializeSelectedConnection,
  selectRemoteConnectionForCommand,
} from '../../cli/commands/connection-runtime.ts';
import { resolveCommandConnection } from '../../cli/connection/command-connection.ts';

export async function materializeRemoteConnectionForCommand(
  options: Omit<Parameters<typeof materializeSelectedConnection>[0], 'selection'>,
): ReturnType<typeof materializeSelectedConnection> {
  const { flags, host } = options;
  const explicitFlagKeys = new Set(
    (Object.keys(flags) as FlagKey[]).filter((key) => flags[key] !== undefined),
  );
  const context = resolveCommandConnection({
    host,
    flags,
    explicitFlagKeys,
    readDefaults: true,
    materializes: true,
  });
  if (!context.connection) return { flags: context.effectiveFlags, runtime: options.runtime };
  const selection = await selectRemoteConnectionForCommand(
    context.connection,
    context.effectiveFlags,
    host,
  );
  return await materializeSelectedConnection({
    ...options,
    flags: context.effectiveFlags,
    selection,
  });
}
