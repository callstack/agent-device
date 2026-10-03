import type { CliFlags } from '@agent-device/contracts/command';

export async function writeCommandOutput(
  flags: CliFlags,
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
