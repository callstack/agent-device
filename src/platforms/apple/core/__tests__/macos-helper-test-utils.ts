import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function withMockedMacOsHelper<T>(
  script: string,
  run: (ctx: { tmpDir: string; helperPath: string }) => Promise<T>,
  options?: { tempPrefix?: string },
): Promise<T> {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), options?.tempPrefix ?? 'agent-device-macos-helper-test-'),
  );
  const helperPath = path.join(tmpDir, 'agent-device-macos-helper');
  await fs.writeFile(helperPath, script, 'utf8');
  await fs.chmod(helperPath, 0o755);
  const previousHelperPath = process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  process.env.AGENT_DEVICE_MACOS_HELPER_BIN = helperPath;

  try {
    return await run({ tmpDir, helperPath });
  } finally {
    if (previousHelperPath === undefined) delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
    else process.env.AGENT_DEVICE_MACOS_HELPER_BIN = previousHelperPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
