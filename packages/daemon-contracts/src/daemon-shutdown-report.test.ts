import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { readDaemonShutdownReport, buildDaemonShutdownReport } from './daemon-shutdown-report.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const claim = {
  deviceKey: 'local:android:none:emulator-5554',
  session: 'default',
  platform: 'android',
  deviceId: 'emulator-5554',
};

/** The lifetime a report of this suite states, and a different run of the same pid. */
const AUTHOR = { pid: 4242, startTime: 'Mon Jan 1 00:00:00 2026' };
const SAME_PID_LATER_RUN = { pid: 4242, startTime: 'Tue Jan 2 00:00:00 2026' };

test("a report left by an earlier run of the same pid is not this stop's cleanup record", async () => {
  // The state directory outlives every daemon run in it, and pids come round. A stop reads the report
  // AFTER the process is gone, so the only thing that says whose cleanup a record describes is the
  // lifetime it names. Reading an older run's report would tell the caller devices were released by the
  // daemon that just exited, when in truth this run's own write was refused and left the old one standing.
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');

  try {
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        buildDaemonShutdownReport(
          {
            providerReleases: { released: [], pending: [] },
            claims: { released: [claim], orphaned: [], superseded: [], unattributable: [] },
          },
          AUTHOR,
        ),
      ),
    );

    expect(await readDaemonShutdownReport(stateDir, AUTHOR)).toEqual({
      providerReleases: { released: [], pending: [] },
      claims: { released: [claim], orphaned: [], superseded: [], unattributable: [] },
    });
    expect(await readDaemonShutdownReport(stateDir, SAME_PID_LATER_RUN)).toBeNull();
    // A report that predates the field states no author, which is the additive case: its known parts
    // are still read, and a caller that asks for none is not asking for a lifetime.
    expect(await readDaemonShutdownReport(stateDir)).toEqual({
      providerReleases: { released: [], pending: [] },
      claims: { released: [claim], orphaned: [], superseded: [], unattributable: [] },
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a stop that expects attribution is not answered by a record that proves no lifetime', async () => {
  // The stop passes the lifetime it stopped precisely so the answer is about THAT run. A record that states
  // no author, or states one with no start time, cannot say which run wrote it — and a recycled pid looks
  // exactly like that. Crediting such a record would tell the caller devices were released by the daemon
  // that just exited, on the strength of a file that cannot name its writer.
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');
  const outcome = {
    providerReleases: { released: [], pending: [] },
    claims: { released: [claim], orphaned: [], superseded: [], unattributable: [] },
  };

  try {
    // A record from before the field existed: still readable for a caller that asks for no lifetime...
    fs.writeFileSync(reportPath, JSON.stringify(outcome));
    expect(await readDaemonShutdownReport(stateDir)).toEqual(outcome);
    // ...and worth nothing to a caller that does.
    expect(await readDaemonShutdownReport(stateDir, AUTHOR)).toBeNull();

    // A record that states this pid and no start time: indistinguishable from an earlier run of a pid that
    // has since been recycled, so it states no author for the purpose of attribution.
    fs.writeFileSync(reportPath, JSON.stringify({ ...outcome, writtenBy: { pid: AUTHOR.pid } }));
    expect(await readDaemonShutdownReport(stateDir, AUTHOR)).toBeNull();

    // A record that states the caller's own pid and a start time of null, the same shape from the other side.
    fs.writeFileSync(
      reportPath,
      JSON.stringify(buildDaemonShutdownReport(outcome, { pid: AUTHOR.pid, startTime: null })),
    );
    expect(
      await readDaemonShutdownReport(stateDir, { pid: AUTHOR.pid, startTime: null }),
    ).toBeNull();

    // A pid that is not the caller's at all.
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        buildDaemonShutdownReport(outcome, { pid: 9999, startTime: AUTHOR.startTime }),
      ),
    );
    expect(await readDaemonShutdownReport(stateDir, AUTHOR)).toBeNull();

    // And the one record that does prove it: this pid, this lifetime.
    fs.writeFileSync(reportPath, JSON.stringify(buildDaemonShutdownReport(outcome, AUTHOR)));
    expect(await readDaemonShutdownReport(stateDir, AUTHOR)).toEqual(outcome);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('round-trips provider release and device claim records without lease credentials', async () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const lease: DeviceLease = {
    leaseId: 'lease-1',
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 0,
    heartbeatAt: 0,
    expiresAt: 0,
  };

  try {
    const report = buildDaemonShutdownReport(
      {
        providerReleases: { released: [lease], pending: [lease] },
        claims: { released: [claim], orphaned: [], superseded: [claim], unattributable: [] },
      },
      AUTHOR,
    );

    fs.writeFileSync(path.join(stateDir, 'daemon-shutdown.json'), JSON.stringify(report));
    expect(await readDaemonShutdownReport(stateDir)).toEqual({
      providerReleases: {
        released: [{ leaseId: lease.leaseId, provider: 'limrun' }],
        pending: [{ leaseId: lease.leaseId, provider: 'limrun' }],
      },
      claims: { released: [claim], orphaned: [], superseded: [claim], unattributable: [] },
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a report written before claim reporting still reads its provider releases', async () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');

  try {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ providerReleases: { released: [], pending: [] } }),
    );

    expect(await readDaemonShutdownReport(stateDir)).toEqual({
      providerReleases: { released: [], pending: [] },
      claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ignores malformed shutdown reports', async () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');

  try {
    expect(await readDaemonShutdownReport(stateDir)).toBeNull();
    fs.writeFileSync(reportPath, JSON.stringify({ providerReleases: { released: [] } }));
    expect(await readDaemonShutdownReport(stateDir)).toBeNull();

    fs.writeFileSync(
      reportPath,
      JSON.stringify({ providerReleases: { released: [{}], pending: [] } }),
    );
    expect(await readDaemonShutdownReport(stateDir)).toBeNull();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a report written before unattributable claims were separated still reads its three buckets', async () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');
  const claim = {
    deviceKey: 'local:android:none:emulator-5554',
    session: 'default',
    platform: 'android',
    deviceId: 'emulator-5554',
  };

  try {
    // The shape a previous daemon writes. `unattributable` is additive, so a reader of a report from
    // before it existed must still get every bucket it can describe rather than dropping the section.
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        providerReleases: { released: [], pending: [] },
        claims: { released: [claim], orphaned: [claim], superseded: [claim] },
      }),
    );

    expect(await readDaemonShutdownReport(stateDir)).toEqual({
      providerReleases: { released: [], pending: [] },
      claims: { released: [claim], orphaned: [claim], superseded: [claim], unattributable: [] },
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
