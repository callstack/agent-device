import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseHarmonyPid, parseHarmonyProcStatusMemory, parseHarmonyTopCpuUsage } from '../perf.ts';

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
