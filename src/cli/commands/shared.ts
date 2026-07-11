import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';
import { printJson } from '../../utils/output.ts';

export function writeCommandOutput(
  flags: CliFlags,
  data: unknown,
  renderHuman?: () => string | null | undefined,
): void {
  if (flags.json) {
    printJson({ success: true, data });
    return;
  }
  const text = renderHuman?.();
  if (text) writeLine(text);
}

function writeLine(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}
