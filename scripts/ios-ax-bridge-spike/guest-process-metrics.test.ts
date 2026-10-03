import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseProcessTime, processUsageDelta } from './guest-process-metrics.ts';

test('parses macOS process CPU time and derives one request resource sample', () => {
  assert.equal(parseProcessTime('0:00.37'), 370);
  assert.equal(parseProcessTime('1:02:03.50'), 3_723_500);
  assert.equal(parseProcessTime('2-01:02:03.50'), 176_523_500);
  assert.deepEqual(
    processUsageDelta({ cpuMs: 120, memoryBytes: 10 }, { cpuMs: 350, memoryBytes: 42 }),
    { cpuMs: 230, memoryBytes: 42 },
  );
  assert.deepEqual(processUsageDelta(undefined, { cpuMs: 350, memoryBytes: 42 }), {
    cpuMs: 350,
    memoryBytes: 42,
  });
});
