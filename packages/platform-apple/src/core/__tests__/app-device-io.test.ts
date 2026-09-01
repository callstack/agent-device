import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { ensureBootedSimulator, runSimctl } = vi.hoisted(() => ({
  ensureBootedSimulator: vi.fn(),
  runSimctl: vi.fn(),
}));

vi.mock('../simulator.ts', () => ({
  ensureBootedSimulator,
  requireSimulatorDevice: (device: DeviceInfo) => {
    if (device.kind !== 'simulator') throw new Error('simulator required');
  },
}));
vi.mock('../apps-simctl.ts', () => ({ runSimctl }));

import { pushIosNotification } from '../app-device-io.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'apple-push-abort',
  name: 'Apple push abort',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  ensureBootedSimulator.mockReset();
  ensureBootedSimulator.mockResolvedValue(undefined);
  runSimctl.mockReset();
});

test('aborts an in-flight simctl push with the deployment binding signal', async () => {
  const controller = new AbortController();
  const aborted = new Error('request aborted');
  runSimctl.mockImplementation(
    async (_device: DeviceInfo, _args: string[], options: Readonly<{ signal?: AbortSignal }>) =>
      await rejectWhenAborted(options.signal),
  );

  const pending = pushIosNotification(
    device,
    'com.example.app',
    { aps: {} },
    {
      signal: controller.signal,
    },
  );
  await vi.waitFor(() => expect(runSimctl).toHaveBeenCalledOnce());
  expect(runSimctl).toHaveBeenCalledWith(
    device,
    ['push', device.id, 'com.example.app', expect.stringContaining('payload.apns')],
    { signal: controller.signal },
  );
  controller.abort(aborted);

  await expect(pending).rejects.toBe(aborted);
});

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
