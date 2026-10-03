import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { runHarmonyShell } = vi.hoisted(() => ({ runHarmonyShell: vi.fn() }));

vi.mock('../hdc.ts', () => ({ runHarmonyShell }));

import { parseHarmonyPid, parseHarmonyProcStatusMemory, sampleHarmonyMemoryPerf } from '../perf.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  runHarmonyShell.mockReset();
});

test('HarmonyOS perf parsers read process-scoped memory samples', () => {
  assert.equal(parseHarmonyPid('26839\n'), 26839);
  assert.deepEqual(
    parseHarmonyProcStatusMemory('Name:\tapp\nVmHWM:\t  136828 kB\nVmRSS:\t  136556 kB\n'),
    { totalRssKb: 136556, peakRssKb: 136828 },
  );
});

test('HarmonyOS perf parsers reject incomplete process output', () => {
  assert.equal(parseHarmonyPid('not-running'), undefined);
  assert.equal(parseHarmonyProcStatusMemory('VmSize:\t123 kB'), undefined);
});

test('HarmonyOS perf samples resolve a process before collecting memory', async () => {
  runHarmonyShell
    .mockResolvedValueOnce({ exitCode: 0, stdout: '42\n', stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'VmRSS:\t  256 kB\nVmHWM:\t  512 kB\n',
      stderr: '',
    });

  const memory = await sampleHarmonyMemoryPerf(DEVICE, 'com.example.application');

  assert.deepEqual(memory.totalRssKb, 256);
  assert.equal(memory.peakRssKb, 512);
  assert.deepEqual(
    runHarmonyShell.mock.calls.map(([, args]) => args),
    [
      ['pidof', 'com.example.application'],
      ['cat', '/proc/42/status'],
    ],
  );
});

test('HarmonyOS perf reports missing processes and incomplete samples', async () => {
  runHarmonyShell.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' });
  await assert.rejects(
    () => sampleHarmonyMemoryPerf(DEVICE, 'com.example.application'),
    /running process/,
  );

  runHarmonyShell
    .mockResolvedValueOnce({ exitCode: 0, stdout: '42\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'VmSize:\t  1 kB\n', stderr: '' });
  await assert.rejects(
    () => sampleHarmonyMemoryPerf(DEVICE, 'com.example.application'),
    /resident memory/,
  );
});
