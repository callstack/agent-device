import { runEntry } from './cli/entry.ts';

declare const __AGENT_DEVICE_VERSION__: string;

async function captureCliHost() {
  const { captureHostEnvironment } = await import('@agent-device/host-kit/environment');
  return captureHostEnvironment(process);
}

runEntry(
  process.argv.slice(2),
  {
    rootHelp: async () =>
      (await import('./commands/schema/cli-help-overview.ts')).renderCliHelpOverview(),
    help: () => import('./commands/schema/cli-help.ts'),
    cli: async () => {
      const host = await captureCliHost();
      const { runCliProcess } = await import('./cli/process-entry.ts');
      return { runCliProcess: (argv) => runCliProcess(argv, host) };
    },
    mcp: async () => {
      const [host, { withCommandHost }] = await Promise.all([
        captureCliHost(),
        import('@agent-device/host-kit/command'),
      ]);
      const { runAgentDeviceMcpServer } = await import('./mcp/server.ts');
      return {
        runAgentDeviceMcpServer: async (options) =>
          await withCommandHost(
            { host, requestEnv: undefined },
            async () => await runAgentDeviceMcpServer(options),
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
