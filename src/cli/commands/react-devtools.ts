import type { CliFlags } from '@agent-device/contracts/command';
import { runReactDevtools, type ReactDevtoolsCommandOptions } from '@agent-device/react-native';
import { writeCliOutput } from './shared.ts';

export async function runReactDevtoolsCommand(
  args: string[],
  options: ReactDevtoolsCommandOptions & { flags?: Partial<Pick<CliFlags, 'json'>> },
): Promise<number> {
  const output = await runReactDevtools(args, options);
  await writeCliOutput(options.flags ?? {}, output);
  return 0;
}
