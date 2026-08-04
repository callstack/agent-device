import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  clearDaemonShutdownReport,
  readDaemonShutdownReport,
  writeDaemonShutdownReport,
} from '../daemon-shutdown-report.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('round-trips provider release records without persisting lease credentials', () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });

  try {
    writeDaemonShutdownReport(stateDir, { released: [lease], pending: [lease] });

    expect(readDaemonShutdownReport(stateDir)).toEqual({
      providerReleases: {
        released: [{ leaseId: lease.leaseId, provider: 'limrun' }],
        pending: [{ leaseId: lease.leaseId, provider: 'limrun' }],
      },
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ignores malformed shutdown reports and clear removes a prior report', () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');

  try {
    expect(readDaemonShutdownReport(stateDir)).toBeNull();
    fs.writeFileSync(reportPath, JSON.stringify({ providerReleases: { released: [] } }));
    expect(readDaemonShutdownReport(stateDir)).toBeNull();

    fs.writeFileSync(
      reportPath,
      JSON.stringify({ providerReleases: { released: [{}], pending: [] } }),
    );
    expect(readDaemonShutdownReport(stateDir)).toBeNull();

    clearDaemonShutdownReport(stateDir);
    expect(fs.existsSync(reportPath)).toBe(false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
