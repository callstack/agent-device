import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { readCurrentOwnerIdentity, isProcessAlive } from '@agent-device/host-kit/process';
import * as hostProcess from '@agent-device/host-kit/process';
import {
  tryAcquireDaemonRegistration,
  stopAndRetireDaemon,
  recoverAbandonedDaemonRegistration,
  createOwnedReplayStateDir,
  DAEMON_STARTUP_EXIT_CODES,
  launchDaemonProcess,
  type DaemonRetirementResult,
  type OwnedReplayStateDir,
} from '../daemon-registration-owner.ts';
import { resolveDaemonPaths, type DaemonPaths } from '../daemon-resolution.ts';
import { readRegisteredDaemonOwnership } from '../daemon-registration.ts';
import { readDaemonShutdownReport } from '../daemon-shutdown-report.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import {
  registeredDaemonFixtureArgs,
  spawnRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} from './test-utils/registered-daemon-fixture.ts';
import { spawnLegacyDaemonFixture } from './test-utils/legacy-daemon-fixture.ts';
import { ensureDaemon, resolveClientSettings } from '../daemon-client/daemon-client-lifecycle.ts';
import { inspectProcessLock } from '@agent-device/host-kit/file';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { stopDaemonProcess } from '../daemon-process.ts';
import { stopDaemon } from '../daemon/daemon-stop.ts';

const fields = {
  socketPort: 4210,
  token: 'token',
  version: '0.0.0-test',
  codeOrigin: 'checkout' as const,
  codeSignature: 'signature',
};
const ownIdentity = readCurrentOwnerIdentity();
const report = {
  providerReleases: { released: [], pending: [] },
  claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
};

afterEach(() => vi.restoreAllMocks());

async function acquire(
  paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-registration-owner-')),
) {
  const attempt = await tryAcquireDaemonRegistration(paths);
  assert.equal(attempt.status, 'acquired');
  if (attempt.status !== 'acquired') throw new Error('registration refused');
  return { paths, owner: attempt.owner };
}

function replaceInfo(paths: DaemonPaths, pid: unknown, startTime?: string | null) {
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({ pid, processStartTime: startTime, token: 'token', port: 4210 }),
  );
}

test('publication is atomic, binds identity and paths, and excludes a second acquisition', async () => {
  const { paths, owner } = await acquire();
  owner.publish(fields);
  const before = fs.statSync(paths.infoPath).ino;
  owner.publish({ ...fields, httpPort: 4310 });
  assert.notEqual(fs.statSync(paths.infoPath).ino, before);
  assert.equal(readRegisteredDaemonOwnership(paths.infoPath, ownIdentity).state, 'match');
  assert.equal(JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')).transport, 'dual');
  assert.equal((await tryAcquireDaemonRegistration(paths)).status, 'busy');
  assert.deepEqual(await owner.finish(report), { state: 'removed' });
  assert.equal(fs.existsSync(paths.infoPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.deepEqual(readDaemonShutdownReport(paths.baseDir), report);
});

test('publication truncates the log the daemon is already appending to', async () => {
  const { paths, owner } = await acquire();
  const daemonOutput = fs.openSync(paths.logPath, 'a');
  try {
    fs.writeSync(daemonOutput, 'previous run\n');
    owner.publish(fields);
    fs.writeSync(daemonOutput, 'listening\n');
  } finally {
    fs.closeSync(daemonOutput);
  }
  assert.equal(fs.readFileSync(paths.logPath, 'utf8'), 'listening\n');
  await owner.finish(report);
});

for (const [pid, startTime, reason] of [
  [999_999_999, 'successor-start', 'replaced'],
  [process.pid, 'recycled-start', 'replaced'],
  [process.pid, undefined, 'unproven'],
  [null, undefined, 'ownerless'],
] as const) {
  test(`finish retains ${reason} registration (${String(pid)}, ${String(startTime)})`, async () => {
    const { paths, owner } = await acquire();
    owner.publish(fields);
    replaceInfo(paths, pid, startTime);
    const before = fs.readFileSync(paths.infoPath, 'utf8');
    assert.deepEqual(await owner.finish(), {
      state: reason,
      ...(reason === 'replaced' ? { identity: { pid, startTime } } : {}),
    });
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
    assert.equal(fs.existsSync(paths.lockPath), false);
  });
}

test('absent and corrupt registrations are distinct and corruption is retained', async () => {
  const first = await acquire();
  assert.deepEqual(await first.owner.finish(), { state: 'absent' });
  const second = await acquire();
  fs.writeFileSync(second.paths.infoPath, '{not json');
  assert.deepEqual(await second.owner.finish(), { state: 'ownerless' });
  assert.equal(fs.readFileSync(second.paths.infoPath, 'utf8'), '{not json');
});

test.skipIf(process.getuid?.() === 0)('unreadable metadata is retained', async () => {
  const { paths, owner } = await acquire();
  owner.publish(fields);
  fs.chmodSync(paths.infoPath, 0o000);
  try {
    assert.deepEqual(await owner.finish(), { state: 'unreadable' });
    assert.equal(fs.existsSync(paths.infoPath), true);
  } finally {
    fs.chmodSync(paths.infoPath, 0o600);
  }
});

test('legacy lock files are refused and retained', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-registration-legacy-'));
  const contents = JSON.stringify({ pid: process.pid, processStartTime: ownIdentity.startTime });
  fs.writeFileSync(paths.lockPath, contents);
  const result = await tryAcquireDaemonRegistration(paths);
  assert.equal(result.status, 'unproven');
  assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), contents);
});

test('spent acquisitions cannot publish, remove metadata or write a report', async () => {
  const { paths, owner } = await acquire();
  owner.publish(fields);
  await owner.finish();
  const successor = await acquire(paths);
  successor.owner.publish({ ...fields, token: 'successor-token' });
  fs.writeFileSync(`${paths.baseDir}/daemon-shutdown.json`, JSON.stringify(report));
  const beforeInfo = fs.readFileSync(paths.infoPath, 'utf8');
  const beforeReport = fs.readFileSync(`${paths.baseDir}/daemon-shutdown.json`, 'utf8');
  assert.throws(() => owner.publish(fields));
  await assert.rejects(owner.finish(report));
  assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), beforeInfo);
  assert.equal(fs.readFileSync(`${paths.baseDir}/daemon-shutdown.json`, 'utf8'), beforeReport);
  await successor.owner.finish();
});

test('startup clears a prior report while held; a failed clear releases the acquisition', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-registration-clear-'));
  const reportPath = `${paths.baseDir}/daemon-shutdown.json`;
  fs.writeFileSync(reportPath, 'old report');
  const first = await acquire(paths);
  assert.equal(fs.existsSync(reportPath), false);
  await first.owner.finish();
  const primary = Object.assign(new Error('clear failure'), { code: 'EACCES' });
  const original = fs.rmSync;
  vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (target === reportPath) throw primary;
    return original(target, options);
  });
  await assert.rejects(tryAcquireDaemonRegistration(paths), (error) => error === primary);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test('unlink disappearance is settled, other failures remain primary even when release fails', async () => {
  const first = await acquire();
  first.owner.publish(fields);
  const original = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (target === first.paths.infoPath)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return original(target);
  });
  assert.deepEqual(await first.owner.finish(), { state: 'removed' });
  vi.restoreAllMocks();
  const second = await acquire();
  second.owner.publish(fields);
  const primary = new Error('metadata failure');
  vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (target === second.paths.infoPath) throw primary;
    throw new Error('release failure');
  });
  await assert.rejects(second.owner.finish(), (error) => error === primary);
  assert.equal(fs.existsSync(second.paths.infoPath), true);
  assert.match(fs.readFileSync(second.paths.logPath, 'utf8'), /daemon_registration_release_failed/);
});

const deadIdentity = { pid: 999_999_999, startTime: 'dead-start' };
for (const scenario of [
  {
    name: 'missing-start',
    observed: { pid: process.pid, startTime: null },
    published: ownIdentity,
    retired: false,
  },
  { name: 'live-unverified', observed: ownIdentity, published: ownIdentity, retired: false },
  { name: 'no-observation', observed: null, published: deadIdentity, retired: false },
  { name: 'replaced', observed: deadIdentity, published: ownIdentity, retired: false },
  { name: 'dead', observed: deadIdentity, published: deadIdentity, retired: true },
] as const) {
  test(`retirement respects the captured lifetime (${scenario.name})`, async () => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-retirement-'));
    replaceInfo(paths, scenario.published.pid, scenario.published.startTime);
    const before = fs.readFileSync(paths.infoPath, 'utf8');
    const result = await stopAndRetireDaemon({
      paths,
      observed: scenario.observed,
      mode: 'graceful',
      lockTimeoutMs: 0,
    });
    if (scenario.retired) {
      assert.equal(result.status, 'retired');
      assert.equal(result.removedInfo, true);
      assert.equal(fs.existsSync(paths.infoPath), false);
    } else {
      assert.equal(result.status, 'retained');
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
    }
  });
}

test('abandoned recovery never signals a live owner and absence is inspected under the lock', async () => {
  const { paths, owner } = await acquire();
  owner.publish(fields);
  const before = fs.readFileSync(paths.infoPath, 'utf8');
  const result = await recoverAbandonedDaemonRegistration({ paths, observed: ownIdentity });
  assert.equal(result.status, 'retained');
  assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
  await owner.finish();
  assert.deepEqual(await recoverAbandonedDaemonRegistration({ paths, observed: null }), {
    status: 'absent',
    removedInfo: false,
  });
});

test('retirement preserves a winner holding the startup lock instead of stopping or unlinking it', async () => {
  const { paths, owner } = await acquire();
  owner.publish({ ...fields, token: 'winning-token' });
  const before = fs.readFileSync(paths.infoPath, 'utf8');
  const result = await stopAndRetireDaemon({
    paths,
    observed: { pid: 999_999_999, startTime: 'dead-start' },
    mode: 'force',
    lockTimeoutMs: 0,
  });
  assert.equal(result.status, 'retained');
  if (result.status !== 'retained') throw new Error('retirement unexpectedly completed');
  assert.equal(result.reason, 'lock-busy');
  assert.equal(result.error?.details?.reason, 'process_lock_timeout');
  assert.match(result.error?.hint ?? '', /Restore process inspection/);
  assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
  assert.equal((await tryAcquireDaemonRegistration(paths)).status, 'busy');
  await owner.finish();
});

test('metadata failure remains primary and normalized through a secondary release failure', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-retirement-failures-'));
  const observed = { pid: 999_999_999, startTime: 'dead-start' };
  replaceInfo(paths, observed.pid, observed.startTime);
  const primary = Object.assign(new Error('metadata failure'), { code: 'EIO' });
  const originalUnlink = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (target === paths.infoPath) throw primary;
    return originalUnlink(target);
  });
  const originalRmdir = fs.rmdirSync;
  vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
    if (target === paths.lockPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return originalRmdir(target, options);
  });
  const result = await stopAndRetireDaemon({ paths, observed, mode: 'force' });
  assert.equal(result.status, 'retained');
  if (result.status !== 'retained') throw new Error('retirement unexpectedly completed');
  assert.equal(result.error?.message, 'metadata failure');
  assert.equal(result.error?.code, 'UNKNOWN');
  assert.equal(result.error?.cause?.code, 'EIO');
  assert.equal(fs.existsSync(paths.infoPath), true);
});

test('release failure reports partial retirement rather than success', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-retirement-partial-'));
  const observed = { pid: 999_999_999, startTime: 'dead-start' };
  replaceInfo(paths, observed.pid, observed.startTime);
  const original = fs.rmdirSync;
  vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
    if (target === paths.lockPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original(target, options);
  });
  const result = await stopAndRetireDaemon({ paths, observed, mode: 'force' });
  assert.equal(result.status, 'retained');
  assert.equal(result.removedInfo, true);
  assert.equal(fs.existsSync(paths.infoPath), false);
  assert.equal(fs.existsSync(paths.lockPath), true);
});

test.skipIf(process.getuid?.() === 0)(
  'an acquisition I/O failure retains metadata without reporting contention',
  async () => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-retirement-permission-'));
    replaceInfo(paths, deadIdentity.pid, deadIdentity.startTime);
    const before = fs.readFileSync(paths.infoPath, 'utf8');
    fs.chmodSync(paths.baseDir, 0o500);
    try {
      const result = await recoverAbandonedDaemonRegistration({ paths, observed: deadIdentity });
      assert.equal(result.status, 'retained');
      if (result.status !== 'retained') throw new Error('retirement unexpectedly completed');
      assert.equal(result.reason, 'retirement-unconfirmed');
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
      assert.equal(fs.existsSync(paths.lockPath), false);
    } finally {
      fs.chmodSync(paths.baseDir, 0o700);
    }
  },
);

test('a forged private-directory capability cannot authorize even matching dead metadata removal', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-private-forgery-'));
  replaceInfo(paths, deadIdentity.pid, deadIdentity.startTime);
  const before = fs.readFileSync(paths.infoPath, 'utf8');
  const result = await stopAndRetireDaemon({
    paths,
    observed: deadIdentity,
    mode: 'force',
    ownedStateDir: Object.freeze({ paths }) as OwnedReplayStateDir,
  });
  assert.equal(result.status, 'retained');
  assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
});

test('private retirement closes startup admission, joins the actual child and never recreates a removed directory', async () => {
  const ownedStateDir = createOwnedReplayStateDir();
  const paths = ownedStateDir.paths;
  const args = registeredDaemonFixtureArgs(paths, fields);
  const launch = launchDaemonProcess({ paths, args, serverMode: 'socket', ownedStateDir });
  let contender: ReturnType<typeof launchDaemonProcess> | undefined;
  try {
    assert.ok(launch.startTime);
    await waitForFixtureFile(paths.infoPath);
    contender = launchDaemonProcess({ paths, args, serverMode: 'socket', ownedStateDir });
    assert.equal((await contender.exited).exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
    const input = {
      paths,
      observed: { pid: launch.pid, startTime: launch.startTime },
      mode: 'graceful' as const,
      ownedStateDir,
    };
    const pending = stopAndRetireDaemon(input);
    assert.throws(
      () => launchDaemonProcess({ paths, args, serverMode: 'socket', ownedStateDir }),
      (error: { details?: { reason?: string } }) =>
        error.details?.reason === 'daemon_startup_admission_closed',
    );
    const result = await pending;
    assert.equal(result.status, 'retired', JSON.stringify(result));
    if (result.status !== 'retired') assert.fail('retirement not confirmed');
    assert.equal(result.removedStateDir, true);
    assert.equal((await launch.exited).exitCode, 0);
    assert.equal(fs.existsSync(paths.baseDir), false);
    assert.deepEqual(await stopAndRetireDaemon(input), result);
    assert.equal(fs.existsSync(paths.baseDir), false);
  } finally {
    await finishPrivateTestDaemons(paths, launch, contender);
  }
});

test('private retirement retains the directory while an earlier actual startup child is still paused', async () => {
  const ownedStateDir = createOwnedReplayStateDir();
  const paths = ownedStateDir.paths;
  const args = registeredDaemonFixtureArgs(paths, fields);
  const entry = args[1]!;
  const ready = `${paths.baseDir}/paused-startup.ready`;
  fs.writeFileSync(
    entry,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`,
  );
  const first = launchDaemonProcess({ paths, args, serverMode: 'socket', ownedStateDir });
  let second: ReturnType<typeof launchDaemonProcess> | undefined;
  try {
    await waitForFixtureFile(ready);
    second = launchDaemonProcess({
      paths,
      args: registeredDaemonFixtureArgs(paths, fields),
      serverMode: 'socket',
      ownedStateDir,
    });
    await waitForFixtureFile(paths.infoPath);
    const result = await stopAndRetireDaemon({
      paths,
      observed: { pid: second.pid, startTime: second.startTime ?? null },
      mode: 'graceful',
      ownedStateDir,
      startupJoinTimeoutMs: 0,
    });
    assert.equal(result.status, 'retained', JSON.stringify(result));
    if (result.status !== 'retained') assert.fail('private state unexpectedly retired');
    assert.equal(result.reason, 'startup-unconfirmed');
    assert.equal(result.termination?.status, 'exited');
    assert.equal(fs.existsSync(paths.baseDir), true);
    assert.equal(isProcessAlive(first.pid), true);
    assert.equal((await second.exited).exitCode, 0);
  } finally {
    await finishPrivateTestDaemons(paths, first, second);
  }
});

const privateStartupFailures = [
  ['missing-birth', 'ownership-unproven', []],
  ['unverified-birth', 'exit-unconfirmed', []],
  ['signal-error', 'stop-failed', ['SIGTERM']],
] as const;

for (const [failure, reason, expectedSignals] of privateStartupFailures) {
  test(`private startup completion is joined despite ${failure} proof`, async () => {
    const ownedStateDir = createOwnedReplayStateDir();
    const paths = ownedStateDir.paths;
    const exitPath = path.join(paths.baseDir, 'exit-startup');
    const args = registeredDaemonFixtureArgs(paths, fields);
    fs.appendFileSync(
      args[1]!,
      'setInterval(() => { if (fs.existsSync(path.join(paths.baseDir, "exit-startup"))) process.exit(0); }, 10);',
    );
    const birthProbe =
      failure === 'missing-birth'
        ? vi.spyOn(hostProcess, 'readProcessStartTime').mockReturnValueOnce(null)
        : undefined;
    const launch = launchDaemonProcess({ paths, args, serverMode: 'socket', ownedStateDir });
    birthProbe?.mockRestore();
    let actualStartTime: string | null = null;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitForFixtureFile(paths.infoPath);
      actualStartTime = hostProcess.readProcessStartTime(launch.pid);
      assert.ok(actualStartTime);
      if (failure === 'missing-birth') {
        assert.equal(launch.startTime, undefined);
        replaceInfo(paths, launch.pid);
      } else assert.ok(launch.startTime);
      const metadata = fs.readFileSync(paths.infoPath, 'utf8');
      let joined = false;
      void launch.exited.then(() => {
        joined = true;
      });
      const signal = process.kill.bind(process);
      const signals = vi.spyOn(process, 'kill');
      const primary = Object.assign(new Error('Cannot signal fixture'), { code: 'EIO' });
      if (failure === 'unverified-birth')
        vi.spyOn(hostProcess, 'readProcessStartTime').mockReturnValue(null);
      if (failure === 'signal-error')
        signals.mockImplementation((pid, requested) => {
          if (requested === 'SIGTERM') throw primary;
          return signal(pid, requested);
        });
      const pending = stopAndRetireDaemon({
        paths,
        observed: { pid: launch.pid, startTime: launch.startTime ?? null },
        mode: 'graceful',
        ownedStateDir,
        startupJoinTimeoutMs: 500,
      });
      exitTimer = setTimeout(() => fs.writeFileSync(exitPath, 'exit'), 10);
      const result = await pending;
      assert.equal(joined, true, 'retirement returned before its recorded child completed');
      assert.equal(result.status, 'retained', JSON.stringify(result));
      if (result.status !== 'retained') assert.fail('unproven startup unexpectedly retired');
      assert.equal(result.reason, reason);
      assertPrivateStartupFailureDetails(result, failure, primary);
      assert.deepEqual(
        signals.mock.calls.filter(([, requested]) => requested !== 0),
        expectedSignals.map((requested) => [launch.pid, requested]),
      );
      assert.equal(result.removedInfo, false);
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), metadata);
      assert.equal(fs.existsSync(paths.lockPath), true);
      assert.equal(fs.existsSync(paths.baseDir), true);
    } finally {
      clearTimeout(exitTimer);
      vi.restoreAllMocks();
      await finishPrivateTestDaemons(paths, {
        ...launch,
        startTime: actualStartTime ?? hostProcess.readProcessStartTime(launch.pid) ?? undefined,
      });
    }
  });
}

function assertPrivateStartupFailureDetails(
  result: Extract<DaemonRetirementResult, { status: 'retained' }>,
  failure: (typeof privateStartupFailures)[number][0],
  primary: Error,
): void {
  switch (failure) {
    case 'missing-birth':
      assert.equal(result.error?.details?.reason, 'daemon_private_startup_unowned');
      break;
    case 'unverified-birth':
      assert.deepEqual(result.termination, {
        status: 'retained',
        reason: 'identity-unverified',
        signal: 'SIGTERM',
      });
      break;
    case 'signal-error':
      assert.equal(result.error?.message, primary.message);
      assert.equal(result.error?.cause?.code, 'EIO');
      break;
  }
}

test('private startup completion stays bounded without published birth proof and retains the live child', async () => {
  const ownedStateDir = createOwnedReplayStateDir();
  const paths = ownedStateDir.paths;
  const birthProbe = vi.spyOn(hostProcess, 'readProcessStartTime').mockReturnValueOnce(null);
  const launch = launchDaemonProcess({
    paths,
    args: registeredDaemonFixtureArgs(paths, fields),
    serverMode: 'socket',
    ownedStateDir,
  });
  birthProbe.mockRestore();
  let actualStartTime: string | null = null;
  try {
    await waitForFixtureFile(paths.infoPath);
    actualStartTime = hostProcess.readProcessStartTime(launch.pid);
    assert.ok(actualStartTime);
    assert.equal(launch.startTime, undefined);
    replaceInfo(paths, launch.pid);
    const metadata = fs.readFileSync(paths.infoPath, 'utf8');
    const signals = vi.spyOn(process, 'kill');
    const pending = stopAndRetireDaemon({
      paths,
      observed: { pid: launch.pid, startTime: null },
      mode: 'force',
      ownedStateDir,
      startupJoinTimeoutMs: 0,
    });
    assert.throws(
      () => launchDaemonProcess({ paths, args: [], serverMode: 'socket', ownedStateDir }),
      (error: { details?: { reason?: string } }) =>
        error.details?.reason === 'daemon_startup_admission_closed',
    );
    const result = await pending;
    assert.equal(result.status, 'retained', JSON.stringify(result));
    if (result.status !== 'retained') assert.fail('unproven live startup unexpectedly retired');
    assert.equal(result.reason, 'ownership-unproven');
    assert.equal(result.error?.details?.reason, 'daemon_private_startup_unowned');
    assert.equal(isProcessAlive(launch.pid), true);
    assert.deepEqual(
      signals.mock.calls.filter(([, requested]) => requested !== 0),
      [],
    );
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), metadata);
    assert.equal(fs.existsSync(paths.lockPath), true);
    assert.equal(fs.existsSync(paths.baseDir), true);
  } finally {
    vi.restoreAllMocks();
    await finishPrivateTestDaemons(paths, {
      ...launch,
      startTime: actualStartTime ?? hostProcess.readProcessStartTime(launch.pid) ?? undefined,
    });
  }
});

for (const contents of [
  '{broken',
  '{"owner":"default","reapedAt":1,"expiresAt":1e400}',
  '{"owner":"default","reapedAt":1,"expiresAt":-1e400}',
  ...[false, null, 0, {}].map((commitFailure) =>
    JSON.stringify({
      owner: 'default',
      reapedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      commitFailure,
    }),
  ),
]) {
  test(`malformed repair evidence (${contents}) retains private state after the actual child has exited`, async () => {
    const ownedStateDir = createOwnedReplayStateDir();
    const paths = ownedStateDir.paths;
    const sessionDir = `${paths.sessionsDir}/default`;
    fs.mkdirSync(sessionDir, { recursive: true });
    const evidencePath = `${sessionDir}/repair-tombstone.json`;
    fs.writeFileSync(evidencePath, contents);
    const launch = launchDaemonProcess({
      paths,
      args: registeredDaemonFixtureArgs(paths, fields),
      serverMode: 'socket',
      ownedStateDir,
    });
    try {
      await waitForFixtureFile(paths.infoPath);
      const result = await stopAndRetireDaemon({
        paths,
        observed: { pid: launch.pid, startTime: launch.startTime ?? null },
        mode: 'graceful',
        ownedStateDir,
      });
      assert.equal(result.status, 'retained', JSON.stringify(result));
      if (result.status !== 'retained') assert.fail('repair evidence unexpectedly discarded');
      assert.equal(result.termination?.status, 'exited');
      assert.equal(result.error?.details?.reason, 'repair_evidence_invalid');
      assert.equal(fs.readFileSync(evidencePath, 'utf8'), contents);
      await launch.exited;
    } finally {
      await finishPrivateTestDaemons(paths, launch);
    }
  });
}

async function waitForFixtureFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) await sleep(20);
  assert.equal(fs.existsSync(filePath), true);
}

async function finishPrivateTestDaemons(
  paths: DaemonPaths,
  ...launches: (ReturnType<typeof launchDaemonProcess> | undefined)[]
): Promise<void> {
  for (const launch of launches) {
    if (!launch) continue;
    const termination = await stopDaemonProcess(
      { pid: launch.pid, startTime: launch.startTime ?? null },
      { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 2_000 },
    );
    assert.notEqual(termination.status, 'retained', JSON.stringify(termination));
    await launch.exited;
  }
  fs.rmSync(paths.baseDir, { recursive: true, force: true });
}

async function waitForCutoverFixture(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await sleep(10);
  }
  assert.fail('cutover fixture did not reach its barrier');
}

function legacyDisposition(paths: DaemonPaths): boolean | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(paths.baseDir, 'legacy-disposition.json'), 'utf8'),
    ) as { acquired?: unknown };
    return typeof parsed.acquired === 'boolean' ? parsed.acquired : undefined;
  } catch {
    return undefined;
  }
}

test('cutover refuses an already-running legacy daemon before signaling or changing registration', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-old-daemon-'));
  const legacy = spawnLegacyDaemonFixture(paths);
  try {
    await waitForCutoverFixture(() => fs.existsSync(paths.infoPath));
    const metadata = fs.readFileSync(paths.infoPath, 'utf8');
    const lock = fs.readFileSync(paths.lockPath, 'utf8');
    const contender = spawnRegisteredDaemonFixture(paths, fields, undefined);
    let disposition: Awaited<typeof contender.exited> | undefined;
    void contender.exited.then((result) => {
      disposition = result;
    });
    await waitForCutoverFixture(
      () => Boolean(disposition) || fs.existsSync(path.join(paths.baseDir, 'registration-held')),
    );
    assert.ok(disposition, 'a new daemon must refuse an occupied legacy file');
    assert.equal(disposition.exitCode, DAEMON_STARTUP_EXIT_CODES.unproven);
    await assert.rejects(
      ensureDaemon(
        resolveClientSettings({
          session: 'default',
          command: 'devices',
          positionals: [],
          flags: { stateDir: paths.baseDir },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'daemon_registration_unproven');
        return true;
      },
    );
    assert.equal(process.kill(legacy.pid, 0), true);
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), metadata);
    assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), lock);
  } finally {
    await legacy.stop();
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});

test('a legacy contender cannot unlink a hardened owner while it delays metadata publication', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-new-daemon-'));
  const deferred = path.join(paths.baseDir, 'defer-publication');
  fs.writeFileSync(deferred, 'wait');
  const current = spawnRegisteredDaemonFixture(paths, fields, undefined);
  let legacy: ReturnType<typeof spawnLegacyDaemonFixture> | undefined;
  try {
    await waitForCutoverFixture(() => fs.existsSync(path.join(paths.baseDir, 'registration-held')));
    legacy = spawnLegacyDaemonFixture(paths);
    await waitForCutoverFixture(() => legacyDisposition(paths) !== undefined);
    assert.equal(legacyDisposition(paths), false);
    await legacy.exited;
    const claim = inspectProcessLock(paths.lockPath);
    assert.equal(claim.state, 'held');
    if (claim.state !== 'held') throw new Error('current owner lost its claim');
    assert.equal(claim.owner.pid, current.pid);
    assert.equal(process.kill(current.pid, 0), true);
    assert.equal(fs.existsSync(paths.infoPath), false);
    fs.unlinkSync(deferred);
    await waitForCutoverFixture(() => fs.existsSync(paths.infoPath));
    assert.equal(JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')).pid, current.pid);
  } finally {
    await legacy?.stop();
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});

test('concurrent old and new daemon startup has one owner at the shared lock path', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-cutover-race-'));
  const barrier = path.join(paths.baseDir, 'start');
  const legacy = spawnLegacyDaemonFixture(paths, barrier);
  const current = spawnRegisteredDaemonFixture(paths, fields, undefined, barrier);
  let currentExited = false;
  void current.exited.then(() => {
    currentExited = true;
  });
  try {
    await waitForCutoverFixture(
      () =>
        fs.existsSync(`${barrier}.ready-${legacy.pid}`) &&
        fs.existsSync(`${barrier}.ready-${current.pid}`),
    );
    fs.writeFileSync(barrier, 'start');
    await waitForCutoverFixture(
      () =>
        legacyDisposition(paths) !== undefined &&
        (currentExited || fs.existsSync(path.join(paths.baseDir, 'registration-held'))),
    );
    const oldAcquired = legacyDisposition(paths);
    const claim = inspectProcessLock(paths.lockPath);
    const newAcquired = fs.existsSync(path.join(paths.baseDir, 'registration-held'));
    assert.equal(Number(oldAcquired) + Number(newAcquired), 1);
    if (newAcquired) {
      assert.ok(claim.state === 'held');
      assert.equal(claim.owner.pid, current.pid);
    }
    if (oldAcquired)
      assert.equal((await current.exited).exitCode, DAEMON_STARTUP_EXIT_CODES.unproven);
    else await legacy.exited;
    await waitForCutoverFixture(() => fs.existsSync(paths.infoPath));
    assert.equal(
      JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')).pid,
      newAcquired ? current.pid : legacy.pid,
    );
  } finally {
    await legacy.stop();
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});

for (const mode of ['graceful', 'forced'] as const) {
  test(`manual ${mode} stop awaits actual child exit and protected registration retirement`, async () => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-manual-stop-'));
    if (mode === 'forced') fs.writeFileSync(path.join(paths.baseDir, 'ignore-sigterm'), 'hold');
    const child = spawnRegisteredDaemonFixture(paths, fields, undefined);
    try {
      await waitForFixtureFile(paths.infoPath);
      const result = await stopDaemon({ paths, graceTimeoutMs: 30, killTimeoutMs: 1_000 });
      assert.equal(result.stopped, true);
      assert.equal(result.mode, mode);
      assert.equal(result.cleanupConfidence, mode === 'forced' ? 'unknown' : 'known');
      await child.exited;
      assert.equal(fs.existsSync(paths.infoPath), false);
      assert.equal(fs.existsSync(paths.lockPath), false);
      assert.equal(fs.existsSync(paths.baseDir), true);
    } finally {
      await finishRegisteredDaemonFixture(paths.baseDir);
    }
  });
}

test.for(['different pid', 'different birth', 'joined child'] as const)(
  'startup birth recovery refuses $0 despite published metadata',
  async (proof) => {
    const ownedStateDir = createOwnedReplayStateDir();
    const paths = ownedStateDir.paths;
    const probe = vi.spyOn(hostProcess, 'readProcessStartTime').mockReturnValueOnce(null);
    const launch = launchDaemonProcess({
      paths,
      args: registeredDaemonFixtureArgs(paths, fields),
      serverMode: 'socket',
      ownedStateDir,
    });
    probe.mockRestore();
    let actualStartTime: string | null = null;
    try {
      await waitForFixtureFile(paths.infoPath);
      actualStartTime = hostProcess.readProcessStartTime(launch.pid);
      assert.ok(actualStartTime);
      if (proof === 'joined child') {
        const metadata = fs.readFileSync(paths.infoPath);
        const savedLock = path.join(paths.baseDir, 'saved-lock');
        fs.cpSync(paths.lockPath, savedLock, { recursive: true });
        process.kill(launch.pid, 'SIGTERM');
        await launch.exited;
        fs.writeFileSync(paths.infoPath, metadata);
        fs.cpSync(savedLock, paths.lockPath, { recursive: true });
      } else {
        replaceInfo(
          paths,
          proof === 'different pid' ? process.pid : launch.pid,
          proof === 'different birth' ? 'different-birth' : actualStartTime,
        );
      }
      const metadata = fs.readFileSync(paths.infoPath, 'utf8');
      assert.deepEqual(launch.readIdentity(), { pid: launch.pid, startTime: null });
      assert.equal(launch.startTime, undefined);
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), metadata);
    } finally {
      await finishPrivateTestDaemons(paths, { ...launch, startTime: actualStartTime ?? undefined });
    }
  },
);
