import { expect, test, vi } from 'vitest';
import type { HarmonyPerfHost } from '@agent-device/contracts/perf-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyPerfOperations } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-device',
  name: 'HarmonyOS',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

test('keeps HarmonyOS perf limited to its existing memory sample', async () => {
  const sampleMemory = vi.fn(async () => ({ residentKb: 256 }));
  const operations = createHarmonyPerfOperations({
    resolveHost: () => ({ sampleMemory }) satisfies HarmonyPerfHost,
    device,
  });

  await expect(operations.perfMemorySample({ appId: 'com.example.app' })).resolves.toMatchObject({
    metric: { available: true, residentKb: 256 },
    sampling: { method: 'hdc-shell-proc-status' },
  });
  await expect(operations.perfFrames({})).resolves.toMatchObject({
    metric: { available: false },
  });
  await expect(
    operations.perfMemorySnapshot({ artifactsDir: '/tmp', kind: 'memgraph' }),
  ).resolves.toMatchObject({ artifact: { available: false, kind: 'memgraph' } });
  expect(sampleMemory).toHaveBeenCalledOnce();
});
