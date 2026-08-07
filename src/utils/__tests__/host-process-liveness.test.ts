import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockRunCmdSync } = vi.hoisted(() => ({ mockRunCmdSync: vi.fn() }));

vi.mock('../exec.ts', async () => {
  const actual = await vi.importActual<typeof import('../exec.ts')>('../exec.ts');
  return { ...actual, runCmdSync: mockRunCmdSync };
});

import { isProcessZombie, readProcessStartedAtMs } from '../host-process.ts';

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

test('readProcessStartedAtMs derives the start from mm:ss elapsed time', () => {
  psReturns('   04:05\n');
  assert.equal(readProcessStartedAtMs(4242, 1_000_000), 1_000_000 - (4 * 60 + 5) * 1_000);
});

test('readProcessStartedAtMs handles hh:mm:ss and dd-hh:mm:ss elapsed formats', () => {
  psReturns('1:02:03\n');
  assert.equal(readProcessStartedAtMs(4242, 10_000_000), 10_000_000 - 3_723_000);
  psReturns('18-13:56:27\n');
  assert.equal(
    readProcessStartedAtMs(4242, 2_000_000_000),
    2_000_000_000 - (((18 * 24 + 13) * 60 + 56) * 60 + 27) * 1_000,
  );
});

test('readProcessStartedAtMs returns null for unparseable or failed ps output', () => {
  psReturns('garbage\n');
  assert.equal(readProcessStartedAtMs(4242, 1_000_000), null);
  psReturns('', 1);
  assert.equal(readProcessStartedAtMs(4242, 1_000_000), null);
  assert.equal(readProcessStartedAtMs(-1, 1_000_000), null);
});
