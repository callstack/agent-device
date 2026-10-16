import { withCommandHost } from '@agent-device/host-kit/command';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { runEntry } from './cli/entry.ts';

declare const __AGENT_DEVICE_VERSION__: string;

const host = captureHostEnvironment(process);

runEntry(
  process.argv.slice(2),
  {
    help: () => import('./commands/schema/cli-help.ts'),
    cli: async () => {
      const { runCliProcess } = await import('./cli/process-entry.ts');
      return { runCliProcess: (argv) => runCliProcess(argv, host) };
    },
    mcp: async () => {
      const { runAgentDeviceMcpServer } = await import('./mcp/server.ts');
      return {
        runAgentDeviceMcpServer: async () =>
          await withCommandHost(
            { host, requestEnv: undefined },
            async () => await runAgentDeviceMcpServer(),
          ),
      };
    },
    version: () => import('@agent-device/host-kit/version'),
    processExit: () => import('./cli/process-exit.ts'),
  },
  {
    bundledVersion:
      typeof __AGENT_DEVICE_VERSION__ === 'string' ? __AGENT_DEVICE_VERSION__ : undefined,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
).catch(() => process.exit(1));
