import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { copySimulatorFileToHost } from './simulator-files.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from './tool-provider.ts';

test.each(['app', 'data', 'group.com.example.shared'])(
  'local %s container copies preserve bytes and reuse the resolved container',
  async (containerType) => {
    const directory = await mkdtempForTest('simulator-files-');
    const container = path.join(directory, 'container');
    await fs.mkdir(path.join(container, 'Documents'), { recursive: true });
    const bytes = Buffer.from([0, 128, 255]);
    await fs.writeFile(path.join(container, 'Documents', 'file.bin'), bytes);
    const run = vi.fn(async () => ({ stdout: container, stderr: '', exitCode: 0 }));
    const device: DeviceInfo = {
      platform: 'apple',
      appleOs: 'ios',
      kind: 'simulator',
      id: directory,
      name: 'Simulator',
      booted: true,
    };
    const request = {
      device,
      bundleId: 'com.example.app',
      containerType,
      sourcePath: 'Documents/file.bin',
      destinationPath: path.join(directory, 'out', 'file.bin'),
      timeoutMs: 1000,
    };
    await withAppleToolProvider(createLocalAppleToolProvider({ simctl: { run } }), async () => {
      await expect(
        copySimulatorFileToHost({ ...request, sourcePath: 'Documents/missing.bin' }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await copySimulatorFileToHost(request);
      await copySimulatorFileToHost(request);
      expect(await fs.readFile(request.destinationPath)).toEqual(bytes);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(
        ['get_app_container', device.id, request.bundleId, containerType],
        expect.objectContaining({ timeoutMs: 1000 }),
      );
      await fs.mkdir(path.join(container, 'tmp'));
      await fs.writeFile(path.join(container, 'tmp', 'missing.bin'), 'unrelated file');
      await expect(
        copySimulatorFileToHost({ ...request, sourcePath: 'Documents/missing.bin' }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(run).toHaveBeenCalledTimes(1);
    });
  },
);

test('a replaced app container invalidates its cached path', async () => {
  const directory = await mkdtempForTest('simulator-files-replaced-');
  const oldContainer = path.join(directory, 'old');
  const newContainer = path.join(directory, 'new');
  await fs.mkdir(oldContainer);
  await fs.mkdir(newContainer);
  await fs.writeFile(path.join(oldContainer, 'file.bin'), 'old');
  await fs.writeFile(path.join(newContainer, 'file.bin'), 'new');
  const run = vi
    .fn(async () => ({ stdout: newContainer, stderr: '', exitCode: 0 }))
    .mockResolvedValueOnce({ stdout: oldContainer, stderr: '', exitCode: 0 });
  const device: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    id: directory,
    name: 'Simulator',
    booted: true,
  };
  const request = {
    device,
    bundleId: 'com.example.app',
    containerType: 'data',
    sourcePath: 'file.bin',
    destinationPath: path.join(directory, 'out.bin'),
    timeoutMs: 1000,
  };
  await withAppleToolProvider(createLocalAppleToolProvider({ simctl: { run } }), async () => {
    await copySimulatorFileToHost(request);
    expect(await fs.readFile(request.destinationPath, 'utf8')).toBe('old');
    await fs.rm(oldContainer, { recursive: true });
    await copySimulatorFileToHost(request);
    expect(await fs.readFile(request.destinationPath, 'utf8')).toBe('new');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

test('local inventory and container copies normalize loose host results before reading them', async () => {
  const directory = await mkdtempForTest('simulator-loose-results-');
  await fs.writeFile(path.join(directory, 'file.bin'), 'container bytes');
  const device: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    id: directory,
    name: 'Simulator',
    booted: true,
  };
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args) =>
        ({
          exitCode: 0,
          stdout: Buffer.from(
            args[0] === 'listapps'
              ? JSON.stringify({ 'com.example.app': { CFBundleDisplayName: 'Example' } })
              : directory,
          ),
          stderr: undefined,
        }) as unknown as import('@agent-device/host-kit/command').ExecResult,
    },
  });
  await withAppleToolProvider(provider, async () => {
    const { listIosApps } = await import('./app-resolution.ts');
    expect(await listIosApps(device, 'all')).toEqual([
      { bundleId: 'com.example.app', name: 'Example' },
    ]);
    const destinationPath = path.join(directory, 'copied.bin');
    await copySimulatorFileToHost({
      device,
      bundleId: 'com.example.app',
      containerType: 'data',
      sourcePath: 'file.bin',
      destinationPath,
      timeoutMs: 1000,
    });
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('container bytes');
  });
});

test('an absolute simulator screenshot path does not require an app container lookup', async () => {
  const directory = await mkdtempForTest('simulator-absolute-file-');
  const sourcePath = path.join(directory, 'screenshot.png');
  const destinationPath = path.join(directory, 'output', 'screenshot.png');
  const bytes = Buffer.from([0, 128, 255]);
  await fs.writeFile(sourcePath, bytes);
  const run = vi.fn(async () => {
    throw new Error('container lookup unavailable');
  });
  const device: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    id: directory,
    name: 'Simulator',
    booted: true,
  };
  await withAppleToolProvider(createLocalAppleToolProvider({ simctl: { run } }), async () => {
    await copySimulatorFileToHost({
      device,
      bundleId: 'com.example.app',
      containerType: 'data',
      sourcePath,
      destinationPath,
      timeoutMs: 1000,
    });
  });
  expect(await fs.readFile(destinationPath)).toEqual(bytes);
  expect(run).not.toHaveBeenCalled();
});

test('container copies distinguish the same simulator UDID in different simulator sets', async () => {
  const directory = await mkdtempForTest('simulator-file-set-identity-');
  const sets = [path.join(directory, 'first'), path.join(directory, 'second')];
  for (const [index, setPath] of sets.entries()) {
    await fs.mkdir(path.join(setPath, 'container'), { recursive: true });
    await fs.writeFile(path.join(setPath, 'container', 'file.bin'), `set ${index}`);
  }
  const run = vi.fn(async (args: readonly string[]) => ({
    stdout: path.join(args[1]!, 'container'),
    stderr: '',
    exitCode: 0,
  }));
  await withAppleToolProvider(createLocalAppleToolProvider({ simctl: { run } }), async () => {
    for (const index of [0, 1, 0]) {
      const destinationPath = path.join(directory, `copied-${index}.bin`);
      await copySimulatorFileToHost({
        device: {
          platform: 'apple',
          appleOs: 'ios',
          kind: 'simulator',
          id: directory,
          name: 'Same UDID',
          simulatorSetPath: sets[index],
          booted: true,
        },
        bundleId: 'com.example.app',
        containerType: 'data',
        sourcePath: 'file.bin',
        destinationPath,
        timeoutMs: 1000,
      });
      expect(await fs.readFile(destinationPath, 'utf8')).toBe(`set ${index}`);
    }
  });
  expect(run).toHaveBeenCalledTimes(2);
});
