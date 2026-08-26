import { expect, test, vi } from 'vitest';
import type { AndroidPerfHost } from '@agent-device/contracts/perf-runtime-host';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidPerfOperations } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('owns Android memory observation policy and delegates only native sampling', async () => {
  const sampleMemory = vi.fn(async () => ({ totalPssKb: 512 }));
  const operations = createAndroidPerfOperations({
    resolveHost: () => ({ sampleMemory }) as unknown as AndroidPerfHost,
    device,
    owner: localRuntimeOwner('android'),
  });

  await expect(operations.perfMemorySample({ appId: 'com.example.app' })).resolves.toMatchObject({
    metric: { available: true, totalPssKb: 512 },
    sampling: { method: 'adb-shell-dumpsys-meminfo', unit: 'kB' },
  });
  expect(sampleMemory).toHaveBeenCalledWith(device, 'com.example.app');
});

test('refuses non-Android profile kinds before invoking the report host', async () => {
  const writeProfileReport = vi.fn();
  const operations = createAndroidPerfOperations({
    resolveHost: () => ({ writeProfileReport }) as unknown as AndroidPerfHost,
    device,
    owner: localRuntimeOwner('android'),
  });

  await expect(
    operations.perfProfileReport({
      kind: 'xctrace',
      tracePath: '/tmp/profile.trace',
      outPath: '/tmp/report.json',
    }),
  ).rejects.toThrow('Android native perf requires --kind simpleperf');
  expect(writeProfileReport).not.toHaveBeenCalled();
});
