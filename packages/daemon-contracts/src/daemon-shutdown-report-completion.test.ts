import fs from 'node:fs';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  daemonShutdownCompletionAnswers,
  readDaemonShutdownRecord,
  readDaemonShutdownReport,
  resolveDaemonShutdownReportPath,
} from './daemon-shutdown-report.ts';

const completion = {
  pid: 4242,
  processStartTime: 'birth',
  token: 'runtime-a',
  outcome: 'retained' as const,
  unfinished: ['1 in-flight request ignored cancellation'],
};

test('one record reads the legacy report and completion independently', () => {
  const dir = mkdtempForTestSync('agent-device-shutdown-record-');
  const file = resolveDaemonShutdownReportPath(dir);
  const report = {
    providerReleases: { released: [{ leaseId: 'lease-1' }], pending: [] },
    claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
  };
  for (const present of [false, true]) {
    fs.writeFileSync(file, JSON.stringify({ ...(present ? report : {}), completion }));
    expect(readDaemonShutdownRecord(dir)).toEqual({ report: present ? report : null, completion });
    expect(readDaemonShutdownReport(dir)).toEqual(present ? report : null);
  }
  fs.writeFileSync(file, JSON.stringify({ ...report, completion: { ...completion, token: null } }));
  expect(readDaemonShutdownRecord(dir)).toEqual({ report, completion: null });
});

test.each([
  ['absent', undefined],
  ['malformed', '{not json'],
  ['empty', '{}'],
  [
    'missing lifetime',
    JSON.stringify({ completion: { ...completion, processStartTime: undefined } }),
  ],
  ['missing token', JSON.stringify({ completion: { ...completion, token: undefined } })],
  ['invalid outcome', JSON.stringify({ completion: { ...completion, outcome: 'maybe' } })],
])('unusable %s completion supplies no cleanup evidence', (_label, raw) => {
  const dir = mkdtempForTestSync('agent-device-shutdown-record-');
  if (raw !== undefined) fs.writeFileSync(resolveDaemonShutdownReportPath(dir), raw);
  expect(readDaemonShutdownRecord(dir)).toEqual({ report: null, completion: null });
});

test.each([
  [completion, true],
  [{ ...completion, pid: 9090 }, false],
  [{ ...completion, processStartTime: 'another birth' }, false],
  [{ ...completion, token: 'runtime-b' }, false],
])('completion matches the original runtime identity: %j', (query, matches) => {
  expect(daemonShutdownCompletionAnswers(completion, query)).toBe(matches);
});
