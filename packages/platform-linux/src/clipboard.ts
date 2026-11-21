import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';

export async function readLinuxClipboard(provider: LinuxToolProvider): Promise<string> {
  return await provider.clipboard!.readText();
}

export async function writeLinuxClipboard(
  provider: LinuxToolProvider,
  text: string,
): Promise<void> {
  await provider.clipboard!.writeText(text);
}
