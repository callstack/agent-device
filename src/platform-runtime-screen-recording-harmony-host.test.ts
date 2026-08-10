import { expect, test, vi } from 'vitest';
import { createHarmonyScreenRecordingHost } from './platform-runtime-screen-recording-harmony-host.ts';

const hdc = vi.hoisted(() => vi.fn());
vi.mock('./platforms/harmonyos/hdc.ts', () => ({ runHarmonyHdc: hdc }));

const device = {
  platform: 'harmonyos' as const,
  id: 'harmony-device',
  name: 'Harmony device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

test('reports artifact removal only after a confirmed HDC success', async () => {
  hdc.mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 });
  const host = createHarmonyScreenRecordingHost();

  await expect(host.remove(device, '/data/local/tmp/capture.mp4')).resolves.toBe(false);
  expect(hdc).toHaveBeenCalledWith(device, ['shell', 'rm', '-f', '/data/local/tmp/capture.mp4'], {
    allowFailure: true,
    signal: undefined,
  });
});

test('reads the staged byte count from focused HDC stat output', async () => {
  hdc.mockResolvedValueOnce({ stdout: '12345\n', stderr: '', exitCode: 0 });
  const host = createHarmonyScreenRecordingHost();

  await expect(host.stagedFileSize(device, '/data/local/tmp/capture.mp4')).resolves.toBe(12_345);
  expect(hdc).toHaveBeenCalledWith(
    device,
    ['shell', 'stat', '-c', '%s', '/data/local/tmp/capture.mp4'],
    { allowFailure: true, signal: undefined },
  );
});
