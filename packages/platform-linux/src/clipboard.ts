import type { LinuxToolProvider } from './tool-provider-types.ts';

export async function readLinuxClipboard(provider: LinuxToolProvider): Promise<string> {
  return await provider.clipboard.readText();
}

export async function writeLinuxClipboard(
  provider: LinuxToolProvider,
  text: string,
): Promise<void> {
  await provider.clipboard.writeText(text);
}
