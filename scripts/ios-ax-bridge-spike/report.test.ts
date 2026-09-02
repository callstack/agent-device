import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { test } from 'vitest';
import { corpusCoverage } from './corpus-coverage.ts';
import { markdownPath } from './report.ts';

test('keeps markdown separate from every supported raw artifact path', () => {
  assert.equal(markdownPath('/tmp/evidence.json.gz'), '/tmp/evidence.md');
  assert.equal(markdownPath('/tmp/evidence.json'), '/tmp/evidence.md');
  assert.equal(markdownPath('/tmp/evidence'), '/tmp/evidence.md');
});

test('does not call an unproduced requested corpus full', () => {
  assert.equal(
    corpusCoverage(
      ['cold-cold', 'cold', 'warm', 'relaunch'],
      ['quiet', 'list', 'nested-scroll', 'alert', 'system-surface', 'xctest-stress'],
      [],
      ['guest-simulator-framework-bridge'],
    ),
    'decisive-early-stop',
  );
});

test('ships a readable completed decision inside the checked gzip artifact', () => {
  const compressed = fs.readFileSync('docs/evidence/ios-simulator-ax-bridge-2026-09-01.json.gz');
  const report = JSON.parse(gunzipSync(compressed).toString('utf8')) as {
    schemaVersion?: string;
    status?: string;
    decision?: string;
    corpusCoverage?: string;
  };
  assert.deepEqual(
    {
      schemaVersion: report.schemaVersion,
      status: report.status,
      decision: report.decision,
      corpusCoverage: report.corpusCoverage,
    },
    {
      schemaVersion: 'ios-simulator-ax-bridge-spike.v1',
      status: 'completed',
      decision: 'NO-GO',
      corpusCoverage: 'decisive-early-stop',
    },
  );
});
