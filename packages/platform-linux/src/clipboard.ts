import { resolveLinuxToolProvider } from './tool-provider.ts';

export async function readLinuxClipboard(): Promise<string> {
  return await resolveLinuxToolProvider().clipboard!.readText();
}

export async function writeLinuxClipboard(text: string): Promise<void> {
  await resolveLinuxToolProvider().clipboard!.writeText(text);
}
