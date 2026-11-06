import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempForTest } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { createLimrunRuntimeDependencies } from './limrun-runtime-dependencies.ts';
import { createPerfRuntimeHost } from '../platform-runtime-perf-host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';

const device: DeviceInfo = {
  platform: 'android',
  id: 'limrun:android:perf-test',
  name: 'Limrun Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

// Any unscoped operation must fail instead of accidentally reaching a local device.
vi.mock('@agent-device/host-kit/command', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/command')>()),
  runCmd: async () => {
    throw new Error('Local ADB must not run');
  },
}));

test('Limrun performance reads use the provider ADB and collect heap artifacts', async () => {
  const dependencies = createLimrunRuntimeDependencies({ env: process.env, cwd: process.cwd() });
  const host = createPerfRuntimeHost().android;
  const dir = await mkdtempForTest('limrun-perf-');
  let remoteHeap: string | undefined;
  let frameWindowCleared = false;
  const operations = await dependencies.android.bindPerformance(
    device,
    {
      exec: async (args) => {
        const ok = { exitCode: 0, stdout: '', stderr: '' };
        switch (args.join(' ')) {
          case 'shell dumpsys meminfo com.example.app':
            return {
              ...ok,
              stdout: 'TOTAL PSS: 52000 TOTAL RSS: 100112 TOTAL SWAP PSS: 0',
            };
          case 'shell dumpsys gfxinfo com.example.app framestats':
            return {
              ...ok,
              stdout: 'Total frames rendered: 100\nJanky frames: 5 (5.0%)',
            };
          case 'shell dumpsys gfxinfo com.example.app reset':
            frameWindowCleared = true;
            return ok;
          case 'shell pidof com.example.app':
            return { ...ok, stdout: '123' };
        }
        if (args.slice(0, 4).join(' ') === 'shell am dumpheap com.example.app') {
          remoteHeap = args[4];
          return ok;
        }
        if (args[0] === 'pull' && args[1] === remoteHeap) {
          await writeFile(args[2]!, 'JAVA PROFILE 1.0.3\0');
          return ok;
        }
        if (args.slice(0, 3).join(' ') === 'shell rm -f' && args[3] === remoteHeap) {
          remoteHeap = undefined;
          return ok;
        }
        throw new Error(`Unexpected remote call: ${args.join(' ')}`);
      },
    },
    host,
    providerRuntimeOwner('limrun', 'default'),
  );
  await expect(operations.perfMemorySample!({ appId: 'com.example.app' })).resolves.toMatchObject({
    metric: { available: true, totalPssKb: 52000, totalRssKb: 100112 },
    sampling: { method: 'adb-shell-dumpsys-meminfo' },
  });
  await expect(operations.perfFrames!({ appId: 'com.example.app' })).resolves.toMatchObject({
    metric: { available: true, totalFrameCount: 100, droppedFrameCount: 5 },
  });
  expect(frameWindowCleared).toBe(true);
  const heap = `${dir}/heap.hprof`;
  await expect(
    operations.perfMemorySnapshot!({
      appId: 'com.example.app',
      artifactsDir: dir,
      outPath: heap,
    }),
  ).resolves.toMatchObject({ artifact: { available: true, path: heap, pid: 123 } });
  expect(await readFile(heap, 'utf8')).toBe('JAVA PROFILE 1.0.3\0');
  expect(remoteHeap).toBeUndefined();
});
