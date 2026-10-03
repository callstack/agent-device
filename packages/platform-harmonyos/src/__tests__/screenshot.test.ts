import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { readFile, runHarmonyHdc, runHarmonyShell } = vi.hoisted(() => ({
  readFile: vi.fn(),
  runHarmonyHdc: vi.fn(),
  runHarmonyShell: vi.fn(),
}));

vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/host-file')>()),
  readHostBinaryFile: readFile,
}));
vi.mock('../hdc.ts', () => ({ runHarmonyHdc, runHarmonyShell }));

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
  runHarmonyShell.mockReset();
  runHarmonyHdc.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  runHarmonyShell.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  readFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
});

test('screenshotHarmony captures, retrieves, validates, and cleans a JPEG', async () => {
  await screenshotHarmony(DEVICE, '/tmp/capture.jpg');

  const shellCalls = runHarmonyShell.mock.calls.map(([, args]) => args);
  const hdcCalls = runHarmonyHdc.mock.calls.map(([, args]) => args);
  assert.deepEqual(shellCalls[0]?.slice(0, 2), ['snapshot_display', '-f']);
  assert.match(String(shellCalls[0]?.[2]), /^\/data\/local\/tmp\/agent-device-screen-.+\.jpeg$/);
  assert.deepEqual(hdcCalls[0]?.slice(0, 2), ['file', 'recv']);
  assert.match(String(hdcCalls[0]?.[2]), /^\/data\/local\/tmp\/agent-device-screen-.+\.jpeg$/);
  assert.equal(hdcCalls[0]?.[3], '/tmp/capture.jpg');
  assert.deepEqual(shellCalls[1]?.slice(0, 2), ['rm', '-f']);
  assert.deepEqual(readFile.mock.calls, [['/tmp/capture.jpg']]);
});

test('screenshotHarmony rejects a retrieved artifact that is not JPEG data', async () => {
  readFile.mockResolvedValue(Buffer.from('not-a-jpeg'));

  await assert.rejects(() => screenshotHarmony(DEVICE, '/tmp/invalid.jpg'), /not a JPEG/);
  assert.equal(runHarmonyShell.mock.calls.length, 2);
  assert.equal(runHarmonyHdc.mock.calls.length, 1);
});
