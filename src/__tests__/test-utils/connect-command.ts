import { vi } from 'vitest';
import { connectCommand } from '../../cli/commands/connection.ts';
import type { AgentDeviceClient } from '../../agent-device-client.ts';

/** Runs `connect` the way the CLI does, writing its generated profile under `stateDir`. */
export async function connectWithGeneratedProviderProfile(options: {
  stateDir: string;
  positionals: string[];
  flags: Partial<Parameters<typeof connectCommand>[0]['flags']>;
}): Promise<void> {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await connectCommand({
      positionals: options.positionals,
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir: options.stateDir,
        ...options.flags,
      },
      client: {} as AgentDeviceClient,
    });
  } finally {
    stdoutWrite.mockRestore();
  }
}
