import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import { sampleLegacyAndroidCpuPerf } from '../perf-legacy-cpu.ts';

test('sampleLegacyAndroidCpuPerf preserves aggregate package-process CPU semantics', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push([...args]);
    return {
      exitCode: 0,
      stderr: '',
      stdout: [
        '12.5% 1234/com.example.app: 7.5% user + 5% kernel',
        '3.5% 5678/com.example.app:worker: 2% user + 1.5% kernel',
        '2% 9999/com.example.other: 1% user + 1% kernel',
      ].join('\n'),
    };
  };

  const sample = await sampleLegacyAndroidCpuPerf(ANDROID_EMULATOR, 'com.example.app', { adb });

  assert.deepEqual(calls, [['shell', 'dumpsys', 'cpuinfo']]);
  assert.equal(sample.usagePercent, 16);
  assert.equal(sample.method, 'adb-shell-dumpsys-cpuinfo');
  assert.deepEqual(sample.matchedProcesses, ['com.example.app', 'com.example.app:worker']);
});
