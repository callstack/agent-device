import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { IOS_TEST_SIMULATOR } from './__tests__/apple-core-stub-helpers.ts';
import { readSimulatorAppInfoPlist } from './local-simulator-apps.ts';

test('app metadata shares one timeout between container lookup and plist conversion', async () => {
  const appPath = await mkdtempForTest('simulator-app-info-budget-');
  await fs.writeFile(path.join(appPath, 'Info.plist'), '');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const signal = new AbortController().signal;
  const convert = vi.fn(async () => ({
    stdout: JSON.stringify({ CFBundleIdentifier: 'com.example.app' }),
    stderr: '',
    exitCode: 0,
  }));
  try {
    const plist = await readSimulatorAppInfoPlist(
      {
        simctl: {
          run: async () => {
            now += 80;
            return { stdout: appPath, stderr: '', exitCode: 0 };
          },
        },
        runCommand: convert,
      },
      { device: IOS_TEST_SIMULATOR, bundleId: 'com.example.app', timeoutMs: 100, signal },
    );
    expect(plist?.CFBundleIdentifier).toBe('com.example.app');
    expect(convert).toHaveBeenCalledWith(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Info.plist')],
      { allowFailure: true, timeoutMs: 20, signal },
    );
  } finally {
    clock.mockRestore();
  }
});
