import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { PNG } from '@agent-device/capture-kit/png';
import { screenshotIos } from '../screenshot.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

function startsWithArgs(args: string[], expected: string[]): boolean {
  return expected.every((value, index) => args[index] === value);
}

test('screenshotIos caches simulator screen scale per device', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-screenshot-scale-cache-');
  const outPath = path.join(tmpDir, 'screen.png');
  const sourcePngPath = path.join(tmpDir, 'source.png');
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-scale-cache',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };

  await fs.writeFile(sourcePngPath, PNG.sync.write(new PNG({ width: 2, height: 2 })));
  const calls: string[][] = [];
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args) => {
        calls.push(args);
        if (startsWithArgs(args, ['getenv', device.id, 'SIMULATOR_MAINSCREEN_SCALE'])) {
          return { exitCode: 0, stdout: '3\n', stderr: '' };
        }
        if (startsWithArgs(args, ['io', device.id, 'screenshot'])) {
          await fs.copyFile(sourcePngPath, String(args[3]));
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected simctl call: ${args.join(' ')}`);
      },
    },
  });

  try {
    await withAppleToolProvider(provider, async () => {
      const options = { pixelDensity: 3, skipIosSimulatorBootCheck: true } as const;
      await screenshotIos(device, outPath, options);
      await screenshotIos(device, outPath, options);
    });

    assert.equal(
      calls.filter((args) =>
        startsWithArgs(args, ['getenv', device.id, 'SIMULATOR_MAINSCREEN_SCALE']),
      ).length,
      1,
    );
    assert.equal(
      calls.filter(
        (args) => startsWithArgs(args, ['io', device.id, 'screenshot']) && args[3] === outPath,
      ).length,
      2,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
