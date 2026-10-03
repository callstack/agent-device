import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockRunCmdSync, mockRunCmd } = vi.hoisted(() => ({
  mockRunCmdSync: vi.fn(),
  mockRunCmd: vi.fn(),
}));

vi.mock('./exec.ts', async () => {
  const actual = await vi.importActual<typeof import('./exec.ts')>('./exec.ts');
  return { ...actual, runCmd: mockRunCmd, runCmdSync: mockRunCmdSync };
});

import {
  isProcessZombie,
  readHostProcessIdentityObservations,
  readProcessIdentityFacts,
} from './host-process.ts';

function psReturns(stdout: string, exitCode = 0): void {
  mockRunCmdSync.mockReturnValue({ stdout, stderr: '', exitCode });
}

function psAnswersEachField(fields: Record<string, string>): void {
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const value = fields[args[3]!];
    return { stdout: value ?? '', stderr: '', exitCode: value === undefined ? 1 : 0 };
  });
}

beforeEach(() => {
  mockRunCmdSync.mockReset();
  mockRunCmd.mockReset();
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

test('reads many process identities from one ps snapshot', () => {
  psReturns(`4242 Ss   Mon Aug 10 20:00:00 2026
4343 ZN   Mon Aug 10 20:01:00 2026
`);

  const observations = readHostProcessIdentityObservations([4242, 4343, 4242]);

  assert.deepEqual(observations.get(4242), {
    state: 'Ss',
    startTime: 'Mon Aug 10 20:00:00 2026',
  });
  assert.deepEqual(observations.get(4343), {
    state: 'ZN',
    startTime: 'Mon Aug 10 20:01:00 2026',
  });
  assert.equal(mockRunCmdSync.mock.calls.length, 1);
  assert.deepEqual(mockRunCmdSync.mock.calls[0]?.[1], [
    '-p',
    '4242,4343',
    '-o',
    'pid=,state=,lstart=',
  ]);
});

test('the ownership read spends the budget its caller names on every field', async () => {
  psAnswersEachField({
    'lstart=': 'Mon Aug 10 20:00:00 2026',
    'command=': '/bin/simctl io recordVideo out.mp4',
    'state=': 'Ss',
  });

  const facts = await readProcessIdentityFacts(4242, 5_000);

  assert.deepEqual(facts, {
    startTime: 'Mon Aug 10 20:00:00 2026',
    command: '/bin/simctl io recordVideo out.mp4',
    zombie: false,
  });
  assert.equal(mockRunCmd.mock.calls.length, 3);
  for (const call of mockRunCmd.mock.calls) {
    assert.equal(call[2]?.timeoutMs, 5_000);
  }
});

test('the ownership read reports an unanswered host as unknown, not as absence', async () => {
  mockRunCmd.mockRejectedValue(new Error('/bin/ps timed out after 5000ms'));

  assert.deepEqual(await readProcessIdentityFacts(4242, 5_000), {
    startTime: null,
    command: null,
    zombie: null,
  });
});

test('the ownership read leaves the zombie question open when only the state is unreadable', async () => {
  psAnswersEachField({
    'lstart=': 'Mon Aug 10 20:00:00 2026',
    'command=': '/bin/simctl io recordVideo out.mp4',
  });

  assert.deepEqual(await readProcessIdentityFacts(4242, 5_000), {
    startTime: 'Mon Aug 10 20:00:00 2026',
    command: '/bin/simctl io recordVideo out.mp4',
    zombie: null,
  });
});

test('the ownership read answers the zombie question from the state field', async () => {
  psAnswersEachField({ 'lstart=': 'x', 'command=': 'y', 'state=': 'ZN' });

  assert.deepEqual(await readProcessIdentityFacts(4242), {
    startTime: 'x',
    command: 'y',
    zombie: true,
  });
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.timeoutMs, 1_000);
});
