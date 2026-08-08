import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { runHarmonyHdc } = vi.hoisted(() => ({ runHarmonyHdc: vi.fn() }));

vi.mock('../hdc.ts', () => ({ runHarmonyHdc }));

import {
  parseHarmonyPid,
  parseHarmonyProcStatusMemory,
  parseHarmonyTopCpuUsage,
  sampleHarmonyCpuPerf,
  sampleHarmonyMemoryPerf,
} from '../perf.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  runHarmonyHdc.mockReset();
});

test('HarmonyOS perf parsers read the process-scoped CPU and memory samples', () => {
  assert.equal(parseHarmonyPid('26839\n'), 26839);
  assert.equal(
    parseHarmonyTopCpuUsage(
      '  PID USER PR NI VIRT RES SHR S[%CPU] %MEM TIME+ ARGS\n26839 shell 10 -10 36G 133M 101M S 4.0 3.4 0:00.25 com.example.application\n',
      26839,
    ),
    4,
  );
  assert.deepEqual(
    parseHarmonyProcStatusMemory('Name:\tapp\nVmHWM:\t  136828 kB\nVmRSS:\t  136556 kB\n'),
    { totalRssKb: 136556, peakRssKb: 136828 },
  );
});

test('HarmonyOS perf parsers reject incomplete process output', () => {
  assert.equal(parseHarmonyPid('not-running'), undefined);
  assert.equal(parseHarmonyTopCpuUsage('PID USER', 42), undefined);
  assert.equal(parseHarmonyProcStatusMemory('VmSize:\t123 kB'), undefined);
});

test('HarmonyOS perf samples resolve a process before collecting CPU and memory', async () => {
  runHarmonyHdc
    .mockResolvedValueOnce({ exitCode: 0, stdout: '42\n', stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout:
        'PID USER PR NI VIRT RES SHR S[%CPU] %MEM TIME+ ARGS\n42 shell 0 0 1G 10M 1M S 3.5 0.1 0:00 app',
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '42\n', stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'VmRSS:\t  256 kB\nVmHWM:\t  512 kB\n',
      stderr: '',
    });

  const cpu = await sampleHarmonyCpuPerf(DEVICE, 'com.example.application');
  const memory = await sampleHarmonyMemoryPerf(DEVICE, 'com.example.application');

  assert.equal(cpu.usagePercent, 3.5);
  assert.deepEqual(cpu.matchedProcesses, ['com.example.application']);
  assert.deepEqual(memory.totalRssKb, 256);
  assert.equal(memory.peakRssKb, 512);
  assert.deepEqual(
    runHarmonyHdc.mock.calls.map(([, args]) => args),
    [
      ['shell', 'pidof', 'com.example.application'],
      ['shell', 'top', '-b', '-n', '1'],
      ['shell', 'pidof', 'com.example.application'],
      ['shell', 'cat', '/proc/42/status'],
    ],
  );
});

test('HarmonyOS perf reports missing processes and incomplete samples', async () => {
  runHarmonyHdc.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' });
  await assert.rejects(
    () => sampleHarmonyCpuPerf(DEVICE, 'com.example.application'),
    /running process/,
  );

  runHarmonyHdc
    .mockResolvedValueOnce({ exitCode: 0, stdout: '42\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'VmSize:\t  1 kB\n', stderr: '' });
  await assert.rejects(
    () => sampleHarmonyMemoryPerf(DEVICE, 'com.example.application'),
    /resident memory/,
  );
});
