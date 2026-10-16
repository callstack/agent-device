import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { exitAfterFlush } from './process-exit.ts';

type CliModule = {
  runCli(argv: string[], deps: undefined, host: HostEnvironment): Promise<void>;
};

type LoadCli = () => Promise<CliModule>;

export async function runCliProcess(
  argv: string[],
  host: HostEnvironment,
  loadCli: LoadCli = async () => await import('../cli.ts'),
): Promise<never> {
  const { runCli } = await loadCli();
  await runCli(argv, undefined, host);
  return await exitAfterFlush(0);
}
