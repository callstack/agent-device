// What the daemon does with its OWN state directory when the ground under it is not its own (#4649): a
// state diagnostic is refused, the shutdown is not, and nothing is written through a name another local
// user picked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  establishPrivateDaemonStateDir,
  recordDaemonStartupMarker,
  tryAcquireDaemonRegistration,
  type DaemonRegistrationOwner,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonStartupPhasesPath } from '@agent-device/daemon-contracts/daemon-startup-phases';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';

const fields = {
  socketPort: 4210,
  token: 'token',
  version: '0.0.0-test',
  codeOrigin: 'checkout' as const,
  codeSignature: 'signature',
};
const report = {
  providerReleases: { released: [], pending: [] },
  claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
};

afterEach(() => vi.restoreAllMocks());

async function acquire(): Promise<Acquired> {
  // The real path, because the state rule resolves the route it judges: on macOS `mkdtemp` answers a name
  // under `/var`, which is the alias for `/private/var`, and an ownership fixture keyed on the spelling
  // would then be describing a directory the walk never looked at.
  const paths = resolveDaemonPaths(
    fs.realpathSync(mkdtempForTestSync('agent-device-state-privacy-')),
  );
  const attempt = await tryAcquireDaemonRegistration(paths);
  assert.equal(attempt.status, 'acquired');
  if (attempt.status !== 'acquired') throw new Error('registration refused');
  return { paths, owner: attempt.owner };
}

type Acquired = Readonly<{ paths: DaemonPaths; owner: DaemonRegistrationOwner }>;

test.skipIf(process.platform === 'win32')(
  'a shutdown report replaces a symbolic link at its name, never writes through it',
  async () => {
    const { paths, owner } = await acquire();
    // Another local user who can write the state directory picks the report's name. A write that resolved
    // that name would put the daemon's shutdown record in THEIRS.
    const outside = path.join(paths.baseDir, 'theirs.json');
    fs.writeFileSync(outside, 'theirs\n', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(paths.baseDir, 'daemon-shutdown.json'));
    owner.publish(fields);

    assert.deepEqual(await owner.finish(report), { state: 'removed' });

    assert.equal(fs.readFileSync(outside, 'utf8'), 'theirs\n');
    assert.equal(fs.lstatSync(path.join(paths.baseDir, 'daemon-shutdown.json')).isFile(), true);
    assert.deepEqual(await readDaemonShutdownReport(paths.baseDir), report);
  },
);

test.skipIf(process.platform === 'win32')(
  'a state chain this process cannot read is reported and costs the launcher nothing',
  async () => {
    // The launcher calls this BEFORE its first marker and outside every handler, on the raw argv state dir.
    // `lstat` answers absence politely and lets EACCES, ENOTDIR and ELOOP escape, so a lookup failure here
    // used to lose the process before it wrote a marker or took a registration. A state path the daemon
    // cannot read is a fact about the host: one line on stderr and a startup that goes on, with each record
    // that would land there refused on its own.
    const { paths } = await acquire();
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      assert.doesNotThrow(() => establishPrivateDaemonStateDir(paths.baseDir));
    } finally {
      stderr.mockRestore();
    }

    assert.equal(written.length, 1);
    const said = written.join('');
    assert.match(said, /not private/);
    assert.match(said, /cannot read that part of the state path/);
  },
);

test.skipIf(process.platform === 'win32')(
  'a state directory another local user owns costs every marker, and the startup goes on',
  async () => {
    // The marker is written per startup phase, from three different entry points, and it is the record the
    // daemon appends WITHOUT being asked and while it is still coming up. Ground somebody else controls has
    // to cost it: they picked the directory, they can pre-create the marker's name, and on macOS they can
    // hard-link that name to a file of the daemon user's, so an append would land wherever they arranged.
    const { paths } = await acquire();
    const markerPath = resolveDaemonStartupPhasesPath(paths.baseDir, process.pid);
    serveHostOwnership({ [paths.baseDir]: FOREIGN_UID });

    const reported: unknown[] = [];
    for (const phase of ['modules-loaded', 'lock-acquired', 'listening'] as const) {
      // Never fatal to a startup: a refusal is reported, and the next phase is still attempted.
      recordDaemonStartupMarker(markerPath, phase, (error) => reported.push(error));
    }

    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(reported.length, 3);
    for (const error of reported) {
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'state_dir_untrusted',
      );
      assert.equal(
        (error as { details?: { exposure?: string } }).details?.exposure,
        'foreign_owned',
      );
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'a state directory another local user owns costs the shutdown report, never the shutdown',
  async () => {
    const { paths, owner } = await acquire();
    owner.publish(fields);
    // The daemon writes this record without being asked. Ground somebody else controls gets the refusal,
    // and the shutdown still retires the registration: a diagnostic is never worth a stuck daemon.
    serveHostOwnership({ [paths.baseDir]: FOREIGN_UID });
    // What the refusal reports to is this process's STDERR, never `daemon.log`'s name: a chain that refuses
    // the record refuses an append to that name too, and an append by name would follow a link or block on a
    // FIFO planted there — the very thing being reported. For a detached daemon the launcher has stdout and
    // stderr open on the verified log descriptor, so stderr IS the log there.
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      assert.deepEqual(await owner.finish(report), { state: 'removed' });
    } finally {
      stderr.mockRestore();
    }

    assert.equal(fs.existsSync(path.join(paths.baseDir, 'daemon-shutdown.json')), false);
    assert.match(written.join(''), /daemon_shutdown_record_failed/);
  },
);
