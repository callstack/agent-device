import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockRunCmdSync } = vi.hoisted(() => ({ mockRunCmdSync: vi.fn() }));

vi.mock('../exec.ts', async () => {
  const actual = await vi.importActual<typeof import('../exec.ts')>('../exec.ts');
  return { ...actual, runCmdSync: mockRunCmdSync };
});

import { isProcessZombie } from '../host-process.ts';

function psReturns(stdout: string, exitCode = 0): void {
  mockRunCmdSync.mockReturnValue({ stdout, stderr: '', exitCode });
}

beforeEach(() => {
  mockRunCmdSync.mockReset();
});

test('isProcessZombie detects the Z state code with trailing flags', () => {
  psReturns('ZN  \n');
  assert.equal(isProcessZombie(4242), true);
});

test('isProcessZombie treats running states and ps failures as not zombie', () => {
  psReturns('Ss  \n');
  assert.equal(isProcessZombie(4242), false);
  psReturns('', 1);
  assert.equal(isProcessZombie(4242), false);
  mockRunCmdSync.mockImplementation(() => {
    throw new Error('ps timed out');
  });
  assert.equal(isProcessZombie(4242), false);
});

test('isProcessZombie returns false for an invalid pid without invoking ps', () => {
  assert.equal(isProcessZombie(-1), false);
  assert.equal(mockRunCmdSync.mock.calls.length, 0);
});
