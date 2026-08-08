import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { ensureHdcAvailable, runHarmonyHdc, runCmd } = vi.hoisted(() => ({
  ensureHdcAvailable: vi.fn(),
  runHarmonyHdc: vi.fn(),
  runCmd: vi.fn(),
}));

vi.mock('../hdc.ts', () => ({
  ensureHdcAvailable,
  harmonyDeviceForTarget: (id: string, options: { name: string; emulator: boolean }) => ({
    platform: 'harmonyos',
    id,
    name: options.name,
    kind: options.emulator ? 'emulator' : 'device',
    target: 'mobile',
    booted: true,
  }),
  runHarmonyHdc,
}));
vi.mock('../../../utils/exec.ts', () => ({ runCmd }));

import { listHarmonyDevices, parseHarmonyTargetList } from '../devices.ts';

beforeEach(() => {
  ensureHdcAvailable.mockReset();
  runHarmonyHdc.mockReset();
  runCmd.mockReset();
});

test('parseHarmonyTargetList keeps HDC target ids and ignores its empty sentinel', () => {
  assert.deepEqual(parseHarmonyTargetList('\n127.0.0.1:5555\n9CN0224725020054\n[Empty]\n'), [
    '127.0.0.1:5555',
    '9CN0224725020054',
  ]);
});

test('listHarmonyDevices probes name and characteristics concurrently for every target', async () => {
  runCmd.mockResolvedValue({
    exitCode: 0,
    stdout: '127.0.0.1:5555\n9CN0224725020054\n',
    stderr: '',
  });
  runHarmonyHdc
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'emulator\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'phone\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'HUAWEI Mate 60\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'tv\n', stderr: '' });

  assert.deepEqual(await listHarmonyDevices(), [
    {
      platform: 'harmonyos',
      id: '127.0.0.1:5555',
      name: 'emulator',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    },
    {
      platform: 'harmonyos',
      id: '9CN0224725020054',
      name: 'HUAWEI Mate 60',
      kind: 'device',
      target: 'tv',
      booted: true,
    },
  ]);
  assert.equal(ensureHdcAvailable.mock.calls.length, 1);
  assert.deepEqual(runCmd.mock.calls[0]?.[1], ['list', 'targets']);
  assert.equal(runHarmonyHdc.mock.calls.length, 4);
});

test('listHarmonyDevices reports HDC target-list failures with recovery guidance', async () => {
  runCmd.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'transport unavailable' });

  await assert.rejects(() => listHarmonyDevices({ serial: 'missing' }), /hdc list targets failed/);
});
