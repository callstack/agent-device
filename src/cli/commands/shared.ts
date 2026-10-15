import type { CliOutput } from '../../commands/command-contract.ts';
import type { CliFlags } from '@agent-device/contracts/command';

export async function writeCommandOutput(
  flags: Partial<Pick<CliFlags, 'json'>>,
  data: unknown,
  renderHuman?: () => string | null | undefined,
): Promise<void> {
  if (flags.json) {
    const { printJson } = await import('../../commands/output/json.ts');
    printJson({ success: true, data });
    return;
  }
  const text = renderHuman?.();
  if (text) writeLine(text);
}

function writeLine(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export async function writeCliOutput(
  flags: Partial<Pick<CliFlags, 'json'>>,
  output: CliOutput,
): Promise<void> {
  if (!flags.json && output.stderr) process.stderr.write(output.stderr);
  await writeCommandOutput(
    flags,
    flags.json ? (output.jsonData ?? output.data) : output.data,
    () => output.text,
  );
}
