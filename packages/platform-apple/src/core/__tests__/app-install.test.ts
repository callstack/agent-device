import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { ensureBootedSimulator, runSimctl } = vi.hoisted(() => ({
  ensureBootedSimulator: vi.fn(),
  runSimctl: vi.fn(),
}));

vi.mock('../simulator.ts', () => ({ ensureBootedSimulator }));
vi.mock('../apps-simctl.ts', () => ({
  isMissingAppErrorOutput: () => false,
  runSimctl,
}));

import { installIosInstallablePath } from '../app-install.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'apple-abort',
  name: 'Apple abort',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  ensureBootedSimulator.mockReset();
  ensureBootedSimulator.mockResolvedValue(undefined);
  runSimctl.mockReset();
});

test('aborts an in-flight simctl install with the deployment binding signal', async () => {
  const controller = new AbortController();
  const aborted = new Error('request aborted');
  runSimctl.mockImplementation(
    async (_device: DeviceInfo, _args: string[], options: Readonly<{ signal?: AbortSignal }>) =>
      await rejectWhenAborted(options.signal),
  );

  const pending = installIosInstallablePath(device, '/tmp/App.app', {
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(runSimctl).toHaveBeenCalledOnce());
  expect(runSimctl).toHaveBeenCalledWith(device, ['install', device.id, '/tmp/App.app'], {
    signal: controller.signal,
  });
  controller.abort(aborted);

  await expect(pending).rejects.toBe(aborted);
});

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
