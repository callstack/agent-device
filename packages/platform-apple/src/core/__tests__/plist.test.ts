import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});

import { runCmd } from '@agent-device/host-kit/command';
import { readInfoPlistString } from '../plist.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  vi.resetAllMocks();
});

test('readInfoPlistString falls back to XML parsing when plutil is unavailable', async () => {
  const tmpDir = await mkdtempForTest('agent-device-plist-');
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

test('does not turn an in-flight plist cancellation into a missing value', async () => {
  const controller = new AbortController();
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const provider = createLocalAppleToolProvider({
    plist: {
      readJson: async (_path, signal) => {
        assert.equal(signal, controller.signal);
        markReadStarted?.();
        return await new Promise<Record<string, unknown> | null>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
  });

  await withAppleToolProvider(provider, async () => {
    const pending = readInfoPlistString('/tmp/Info.plist', 'CFBundleIdentifier', controller.signal);
    await readStarted;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  });
});
