import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});

import { runCmd } from '../../../../utils/exec.ts';
import { readInfoPlistString } from '../plist.ts';

const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  vi.resetAllMocks();
});

test('readInfoPlistString falls back to XML parsing when plutil is unavailable', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-plist-'));
  const infoPlistPath = path.join(tmpDir, 'Info.plist');
  await fs.writeFile(
    infoPlistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleExec</string>',
      '<key>CFBundleDisplayName</key><string>Example &amp; App</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: 'missing plutil', exitCode: 1 });

  try {
    assert.equal(await readInfoPlistString(infoPlistPath, 'CFBundleExecutable'), 'ExampleExec');
    assert.equal(await readInfoPlistString(infoPlistPath, 'CFBundleDisplayName'), 'Example & App');
    assert.equal(await readInfoPlistString(infoPlistPath, 'MissingKey'), undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
