import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { createHarmonyHdcRunnerStub, type HarmonyHdcRunnerStub } from '../toolbox.fixtures.ts';

import { parseHarmonyPid, parseHarmonyProcStatusMemory, sampleHarmonyMemoryPerf } from '../perf.ts';

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

let hdc: HarmonyHdcRunnerStub;

beforeEach(() => {
  hdc = createHarmonyHdcRunnerStub();
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
  hdc.answer({ stdout: '42\n' });
  hdc.answer({ stdout: 'VmRSS:\t  256 kB\nVmHWM:\t  512 kB\n' });

  const memory = await sampleHarmonyMemoryPerf(hdc, DEVICE, 'com.example.application');

  assert.deepEqual(memory.totalRssKb, 256);
  assert.equal(memory.peakRssKb, 512);
  assert.deepEqual(
    hdc.calls.map((call) => call.args),
    [
      ['pidof', 'com.example.application'],
      ['cat', '/proc/42/status'],
    ],
  );
});

test('HarmonyOS perf reports missing processes and incomplete samples', async () => {
  const missing = createHarmonyHdcRunnerStub([{ exitCode: 1, stderr: 'not found' }]);
  await assert.rejects(
    () => sampleHarmonyMemoryPerf(missing, DEVICE, 'com.example.application'),
    /running process/,
  );

  const incomplete = createHarmonyHdcRunnerStub([
    { stdout: '42\n' },
    { stdout: 'VmSize:\t  1 kB\n' },
  ]);
  await assert.rejects(
    () => sampleHarmonyMemoryPerf(incomplete, DEVICE, 'com.example.application'),
    /resident memory/,
  );
});
