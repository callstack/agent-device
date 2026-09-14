import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { runHarmonyHdc, runHarmonyShell } from '../hdc.ts';

const DEVICE = { id: 'target-1' };

beforeEach(() => {
  vi.mocked(runCmd).mockClear();
});

test('runHarmonyHdc refuses a raw shell argv and runHarmonyShell quotes every word', async () => {
  await expect(runHarmonyHdc(DEVICE, ['shell', 'uitest', 'uiInput', 'text', 'x'])).rejects.toEqual(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({ reason: 'unguarded-device-shell-argv' }),
    }),
  );
  expect(runCmd).not.toHaveBeenCalled();

  await runHarmonyShell(DEVICE, ['uitest', 'uiInput', 'text', 'hello; reboot']);
  await runHarmonyHdc(DEVICE, ['file', 'recv', '/data/a.png', '/tmp/a.png']);
  expect(vi.mocked(runCmd).mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
    ['hdc', ['-t', 'target-1', 'shell', 'uitest', 'uiInput', 'text', "'hello; reboot'"]],
    ['hdc', ['-t', 'target-1', 'file', 'recv', '/data/a.png', '/tmp/a.png']],
  ]);
});
