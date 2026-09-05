import { runEntry } from './cli/entry.ts';

declare const __AGENT_DEVICE_VERSION__: string;

runEntry(
  process.argv.slice(2),
  {
    help: () => import('./cli-schema/cli-help.ts'),
    cli: () => import('./cli/process-entry.ts'),
    mcp: () => import('./mcp/server.ts'),
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
