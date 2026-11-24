import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { exitAfterFlush, writeStderr, writeStdout } from './process-exit.ts';

type CliModule = {
  runCli(argv: string[], deps: undefined, host: HostEnvironment): Promise<void>;
};

type LoadCli = () => Promise<CliModule>;

export async function runCliProcess(
  argv: string[],
  host: HostEnvironment,
  loadCli: LoadCli = async () => await import('../cli.ts'),
): Promise<never> {
  if (isInformationCandidate(argv)) {
    const { resolveCliOptions } = await import('./resolve-cli-options.ts');
    let parsed: ReturnType<typeof resolveCliOptions> | undefined;
    try {
      parsed = resolveCliOptions(argv, { cwd: host.cwd, env: host.env });
    } catch {
      // The full CLI owns parse failures and their diagnostics.
    }
    if (parsed && (parsed.flags.version || parsed.flags.help || parsed.command === 'help')) {
      const { readVersion } = await import('@agent-device/host-kit/version');
      const version = readVersion();
      for (const warning of parsed.warnings) writeStderr(`Warning: ${warning}\n`);
      if (parsed.flags.version) {
        writeStdout(`${version}\n`);
        return await exitAfterFlush(0);
      }
      return await (
        await import('./help-output.ts')
      ).exitAfterHelp(parsed, parsed.command === 'help');
    }
  }
  const { runCli } = await loadCli();
  await runCli(argv, undefined, host);
  return await exitAfterFlush(0);
}

function isInformationCandidate(argv: string[]): boolean {
  if (argv.includes('connect')) return false;
  return (
    (argv[0] === 'mcp' && (argv.includes('--version') || argv.includes('-V'))) ||
    (argv.includes('--json') &&
      (argv.includes('--help') || argv.includes('-h') || argv.includes('help')))
  );
}
