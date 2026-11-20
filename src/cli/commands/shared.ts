import type { CliOutput } from '@agent-device/command-output';
import type { CliFlags } from '@agent-device/contracts/command';
import { writeStderr, writeStdout, writeStdoutRaw } from '../process-exit.ts';

export async function writeCommandOutput(
  flags: Partial<Pick<CliFlags, 'json'>>,
  data: unknown,
  renderHuman?: () => string | null | undefined | Promise<string | null | undefined>,
  /** The human text escaped its own values to keep intended color, so it is written raw. */
  options: { terminalSafe?: boolean } = {},
): Promise<void> {
  if (flags.json) {
    const { printJson } = await import('../../commands/output/json.ts');
    printJson({ success: true, data });
    return;
  }
  const text = await renderHuman?.();
  if (!text) return;
  const line = text.endsWith('\n') ? text : `${text}\n`;
  if (options.terminalSafe) writeStdoutRaw(line);
  else writeStdout(line);
}

export async function writeCliOutput(
  flags: Partial<Pick<CliFlags, 'json'>>,
  output: CliOutput,
): Promise<void> {
  if (!flags.json && output.stderr) writeStderr(output.stderr);
  await writeCommandOutput(
    flags,
    flags.json ? (output.jsonData ?? output.data) : output.data,
    () => output.text,
    { terminalSafe: output.terminalSafe },
  );
}
