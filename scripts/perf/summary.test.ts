import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parsePerfSummary } from './summary.ts';
import { summaryFixture } from './summary.fixtures.ts';

const valid = () =>
  JSON.parse(JSON.stringify(summaryFixture([{ id: 's/step', daemonMs: [10, 20] }]))) as Record<
    string,
    unknown
  >;

test('accepts a summary that carries every field the comparison reads', () => {
  const summary = parsePerfSummary(valid(), 'summary.json');
  assert.equal(summary.measurements[0]?.daemon?.median, 15);
});

test('rejects another schema version and names the field', () => {
  assert.throws(
    () => parsePerfSummary({ ...valid(), schema: 'agent-device-perf-summary/v0' }, 'a.json'),
    /a\.json: schema must be "agent-device-perf-summary\/v1"/,
  );
});

test('rejects a measurement whose timing summary lost a statistic', () => {
  const summary = valid();
  const [measurement] = summary.measurements as { daemon: Record<string, unknown> }[];
  delete measurement!.daemon.cv;
  assert.throws(
    () => parsePerfSummary(summary, 'b.json'),
    /b\.json: measurements\[0\]\.daemon\.cv must be a finite number/,
  );
});
