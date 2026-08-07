import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from './tmp-dir.ts';

/**
 * Creates a temporary stub `adb` binary that logs all args to a file,
 * prepends it to PATH, and cleans up after the callback finishes.
 */
export async function withMockedAdb(
  tempPrefix: string,
  run: (argsLogPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtempForTest(tempPrefix);
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await run(argsLogPath);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
