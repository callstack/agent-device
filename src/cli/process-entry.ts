import { exitAfterFlush } from '../utils/process-exit.ts';

type CliModule = {
  runCli(argv: string[]): Promise<void>;
};

type LoadCli = () => Promise<CliModule>;

export async function runCliProcess(
  argv: string[],
  loadCli: LoadCli = async () => await import('../cli.ts'),
): Promise<never> {
  const { runCli } = await loadCli();
  await runCli(argv);
  return await exitAfterFlush(0);
}
