import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyHdcRunnerStub, type HarmonyHdcRunnerStub } from '../toolbox.fixtures.ts';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/host-file')>()),
  readHostBinaryFile: readFile,
}));

import { screenshotHarmony } from '../screenshot.ts';

const DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

let hdc: HarmonyHdcRunnerStub;

beforeEach(() => {
  hdc = createHarmonyHdcRunnerStub();
  readFile.mockReset();
  readFile.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
});

test('screenshotHarmony captures, retrieves, validates, and cleans a JPEG', async () => {
  await screenshotHarmony(hdc, DEVICE, '/tmp/capture.jpg');

  const shellWords = hdc.calls.filter((call) => call.kind === 'runShell').map((call) => call.args);
  const pull = hdc.calls.find((call) => call.kind === 'run')!;
  assert.deepEqual(shellWords[0]?.slice(0, 2), ['snapshot_display', '-f']);
  assert.match(String(shellWords[0]?.[2]), /^\/data\/local\/tmp\/agent-device-screen-.+\.jpeg$/);
  assert.deepEqual(pull.args.slice(0, 2), ['file', 'recv']);
  assert.match(String(pull.args[2]), /^\/data\/local\/tmp\/agent-device-screen-.+\.jpeg$/);
  assert.equal(pull.args[3], '/tmp/capture.jpg');
  assert.deepEqual(shellWords[1]?.slice(0, 2), ['rm', '-f']);
  assert.deepEqual(readFile.mock.calls, [['/tmp/capture.jpg']]);
});

test('screenshotHarmony rejects a retrieved artifact that is not JPEG data', async () => {
  readFile.mockResolvedValue(Buffer.from('not-a-jpeg'));

  await assert.rejects(() => screenshotHarmony(hdc, DEVICE, '/tmp/invalid.jpg'), /not a JPEG/);
  // The capture, the pull, and the cleanup all still happened.
  assert.equal(hdc.calls.filter((call) => call.kind === 'runShell').length, 2);
  assert.equal(hdc.calls.filter((call) => call.kind === 'run').length, 1);
});
