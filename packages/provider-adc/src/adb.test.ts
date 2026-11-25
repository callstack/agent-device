import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mkdtempForTest } from '@agent-device/test-kit';
import { expect, it } from 'vitest';
import { createAdbProvider } from './adb.ts';

it.skipIf(process.platform === 'win32')(
  'routes both ADB entry points to the live lease on every call',
  async () => {
    const sdk = await mkdtempForTest('adc-route-');
    const tools = path.join(sdk, 'platform-tools');
    await mkdir(tools);
    const adb = path.join(tools, 'adb');
    await writeFile(
      adb,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))',
      { mode: 0o700 },
    );
    let live = true;
    const provider = createAdbProvider(
      'leased',
      () => {
        if (!live) throw new Error('closed');
        return 'localfilesystem:/private/server';
      },
      { ...process.env, ANDROID_HOME: sdk },
    );
    const result = await provider.exec(['get-state']);
    expect(JSON.parse(result.stdout)).toEqual([
      '-s',
      'leased',
      '-L',
      'localfilesystem:/private/server',
      'get-state',
    ]);
    const child = provider.spawn!(['wait-for-device', 'get-state']);
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.on('error', reject);
    });
    expect(JSON.parse(output)).toEqual([
      '-s',
      'leased',
      '-L',
      'localfilesystem:/private/server',
      'wait-for-device',
      'get-state',
    ]);
    for (const args of [
      ['-s', 'foreign', 'get-state'],
      ['-L', 'tcp:localhost:5037', 'devices'],
      ['wait-for-device', 'kill-server'],
    ]) {
      await expect(provider.exec(args)).rejects.toThrow();
      expect(() => provider.spawn!(args)).toThrow();
    }
    await expect(provider.exec(['get-state'], { serverPort: 5037 })).rejects.toThrow();
    live = false;
    await expect(provider.exec(['get-state'])).rejects.toThrow('closed');
    expect(() => provider.spawn!(['get-state'])).toThrow('closed');
  },
);
