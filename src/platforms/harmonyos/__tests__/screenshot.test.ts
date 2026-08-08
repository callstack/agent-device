import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { readFile, runHarmonyHdc } = vi.hoisted(() => ({
  readFile: vi.fn(),
  runHarmonyHdc: vi.fn(),
}));

vi.mock('node:fs', () => ({ promises: { readFile } }));
vi.mock('../hdc.ts', () => ({ runHarmonyHdc }));

import { screenshotHarmony } from '../screenshot.ts';

const DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  readFile.mockReset();
  runHarmonyHdc.mockReset();
  runHarmonyHdc.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  readFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
});

test('screenshotHarmony captures, retrieves, validates, and cleans a JPEG', async () => {
  await screenshotHarmony(DEVICE, '/tmp/capture.jpg');

  const calls = runHarmonyHdc.mock.calls.map(([, args]) => args);
  assert.deepEqual(calls[0]?.slice(0, 3), ['shell', 'snapshot_display', '-f']);
  assert.match(String(calls[0]?.[3]), /^\/data\/local\/tmp\/agent-device-screen-.+\.jpeg$/);
  assert.deepEqual(calls[1]?.slice(0, 2), ['file', 'recv']);
  assert.match(String(calls[1]?.[2]), /^\/data\/local\/tmp\/agent-device-screen-.+\.jpeg$/);
  assert.equal(calls[1]?.[3], '/tmp/capture.jpg');
  assert.deepEqual(calls[2]?.slice(0, 3), ['shell', 'rm', '-f']);
  assert.deepEqual(readFile.mock.calls, [['/tmp/capture.jpg']]);
});

test('screenshotHarmony rejects a retrieved artifact that is not JPEG data', async () => {
  readFile.mockResolvedValue(Buffer.from('not-a-jpeg'));

  await assert.rejects(() => screenshotHarmony(DEVICE, '/tmp/invalid.jpg'), /not a JPEG/);
  assert.equal(runHarmonyHdc.mock.calls.length, 3);
});
