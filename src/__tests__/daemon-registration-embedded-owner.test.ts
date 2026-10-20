import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { readCurrentOwnerIdentity, isProcessAlive } from '@agent-device/host-kit/process';
import {
  tryAcquireDaemonRegistration,
  stopAndRetireDaemon,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readDaemonShutdownReport,
  resolveDaemonShutdownReportPath,
} from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { mkdtempForTestSync } from '@agent-device/test-kit';

// What the registration owner may do to a record a host process owns: prove the lifetime is gone
// before removing anything, and never signal the process the record names.

/**
 * Whether the signal path was reached, and with what. A signal needs the observed pid to pass the
 * daemon-command-line check, and the process these rows name is the vitest worker, which fails that
 * check. Stubbed to accept it, the rows ask the question they mean to ask: does the record's owner keep
 * the stop away from the signal path, or only a process-table lookup that happens to refuse?
 */
const signalPath = vi.hoisted(() => ({ attempted: [] as number[] }));

vi.mock('@agent-device/daemon-contracts/daemon-process', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/daemon-contracts/daemon-process')>();
  return {
    ...actual,
    stopDaemonProcess: async (
      observed: Parameters<typeof actual.stopDaemonProcess>[0],
      _options: Parameters<typeof actual.stopDaemonProcess>[1],
    ) => {
      // Records the attempt instead of signaling, so the row can tell a refused stop from one that
      // signaled its own test worker. An exit that cannot be confirmed is what a real signal that did
      // not kill anything answers with.
      signalPath.attempted.push(observed.pid);
      return { status: 'retained' as const, reason: 'exit-timeout' as const };
    },
  };
});

const fields = {
  socketPort: 4210,
  token: 'token',
  version: '0.0.0-test',
  codeOrigin: 'checkout' as const,
  codeSignature: 'signature',
};
const ownIdentity = readCurrentOwnerIdentity();
const deadIdentity = { pid: 999_999_999, startTime: 'dead-start' };

/** What a reader that read `ownership` from the record passes on, which is what retirement judges. */
function observedAs(
  identity: { pid: number; startTime: string | null },
  ownership: 'embedded' | 'unknown' | 'detached',
) {
  return { ...identity, ownership };
}

afterEach(() => {
  vi.restoreAllMocks();
  signalPath.attempted.length = 0;
});

/** Writes a record that claims `ownership` for a live process, unreadable variants included. */
function writeRecord(
  paths: ReturnType<typeof resolveDaemonPaths>,
  identity: unknown,
  ownership: unknown = 'embedded',
) {
  const { pid, startTime } = identity as { pid: number; startTime: string };
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({
      pid,
      processStartTime: startTime,
      token: 'token',
      port: 4210,
      ...(ownership === 'corrupt' ? {} : { ownership }),
    }),
  );
  if (ownership === 'corrupt') fs.writeFileSync(paths.infoPath, '{not json');
}

function writeEmbeddedRecord(paths: ReturnType<typeof resolveDaemonPaths>, identity: unknown) {
  writeRecord(paths, identity);
}

/** A live acquisition of a state directory, so the caller holds the claim it judges. */
async function acquire(
  paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-embedded-claim-')),
) {
  const attempt = await tryAcquireDaemonRegistration(paths);
  assert.equal(attempt.status, 'acquired');
  if (attempt.status !== 'acquired') throw new Error('registration refused');
  return { paths, owner: attempt.owner };
}

// A host owns an embedded runtime and ends it with its own close, so retiring that record from outside
// would take the state directory out from under a process that is still serving.
test('retirement of an embedded record proves the lifetime is gone and signals nothing', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-embedded-retirement-'));
  writeEmbeddedRecord(paths, ownIdentity);
  const before = fs.readFileSync(paths.infoPath, 'utf8');
  const signals = vi.spyOn(process, 'kill');

  for (const mode of ['graceful', 'force'] as const) {
    const result = await stopAndRetireDaemon({
      paths,
      observed: observedAs(ownIdentity, 'embedded'),
      mode,
      lockTimeoutMs: 0,
    });
    assert.equal(result.status, 'retained', JSON.stringify(result));
    if (result.status !== 'retained') assert.fail('an embedded owner was retired');
    assert.equal(result.reason, 'embedded-owner');
    assert.equal(result.termination?.status, 'retained');
  }

  // The row that gives this file its teeth: the stub above accepts this pid for the signal path, so
  // only the record's owner stands between this stop and a SIGTERM to the test worker itself.
  assert.deepEqual(signalPath.attempted, [], 'an embedded owner is never reached for a signal');
  assert.deepEqual(
    signals.mock.calls.filter(([, requested]) => requested !== 0),
    [],
    'retirement must not reach into a host process',
  );
  assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before);
  assert.equal(isProcessAlive(ownIdentity.pid), true);
});

// The control that keeps the row above honest: the same live pid, the same stub, and a record proving
// the process is a daemon of its own, and the signal path is taken. Without this row the embedded
// refusal could still be a process-table lookup refusing the worker rather than the owner's rule.
test('a detached record for the same live lifetime does take the signal path', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-detached-signal-'));
  writeRecord(paths, ownIdentity, 'detached');

  const result = await stopAndRetireDaemon({
    paths,
    observed: observedAs(ownIdentity, 'detached'),
    mode: 'graceful',
    lockTimeoutMs: 0,
  });

  assert.deepEqual(
    signalPath.attempted,
    [ownIdentity.pid],
    'a proven detached daemon is the one record a stop signals',
  );
  assert.equal(result.status, 'retained', JSON.stringify(result));
});

test('an embedded record whose lifetime is provably gone retires like any other abandoned one', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-embedded-dead-'));
  writeEmbeddedRecord(paths, deadIdentity);

  // A host that died without closing left the record behind; keeping it would wedge the state directory
  // for every later client with nothing left to close.
  const result = await stopAndRetireDaemon({
    paths,
    observed: observedAs(deadIdentity, 'embedded'),
    mode: 'graceful',
    lockTimeoutMs: 0,
  });
  assert.equal(result.status, 'retired', JSON.stringify(result));
  assert.equal(result.removedInfo, true);
  assert.equal(fs.existsSync(paths.infoPath), false);
});

// A record this build cannot read is not a licence to signal what it names: `detached` is the one
// ownership that authorizes a signal, and an unreadable or unrecognized record proves nothing about
// who owns the process. This is the fail-closed side of the same rule the embedded row above proves.
test('retirement refuses to signal a record whose owner it cannot recognize', async () => {
  for (const ownership of ['sideways', 'corrupt'] as const) {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-owner-unknown-'));
    writeRecord(paths, ownIdentity, ownership);
    const before = fs.readFileSync(paths.infoPath, 'utf8');
    const signals = vi.spyOn(process, 'kill');

    const result = await stopAndRetireDaemon({
      paths,
      observed: observedAs(ownIdentity, 'unknown'),
      mode: 'graceful',
      lockTimeoutMs: 0,
    });
    assert.equal(result.status, 'retained', ownership);
    if (result.status !== 'retained')
      assert.fail(`${ownership}: an unrecognized owner was retired`);
    // The reason differs from the embedded one: nothing here proves the pid is a daemon of its own, so
    // an operator fixes this by inspecting or updating the record, not by closing a host.
    assert.equal(result.reason, 'owner-unproven', ownership);
    assert.deepEqual(
      signalPath.attempted,
      [],
      `${ownership}: an unrecognized owner is never reached for a signal`,
    );
    assert.deepEqual(
      signals.mock.calls.filter(([, requested]) => requested !== 0),
      [],
      `${ownership}: an unrecognized owner is never signaled`,
    );
    assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), before, ownership);
    vi.mocked(process.kill).mockClear();
  }
});

test.each([ownIdentity, deadIdentity])(
  'a JS caller without ownership only proves exit: $pid',
  async (identity) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-owner-omitted-'));
    writeRecord(paths, identity, 'detached');
    const result = await stopAndRetireDaemon({
      paths,
      // @ts-expect-error JavaScript/strip-types callers can bypass the required ownership field.
      observed: identity,
      mode: 'force',
      lockTimeoutMs: 0,
    });
    assert.equal(result.status, identity === ownIdentity ? 'retained' : 'retired');
    if (result.status === 'retained') assert.equal(result.reason, 'owner-unproven');
    assert.deepEqual(signalPath.attempted, []);
    assert.equal(fs.existsSync(paths.infoPath), identity === ownIdentity);
  },
);

test.each(['intentional', 'unlink failure'] as const)(
  'embedded finalization retains its registration and lock for %s',
  async (scenario) => {
    const { paths, owner } = await acquire();
    owner.publish({ ...fields, ownership: 'embedded' });
    const primary = new Error('registration unlink failed');
    const originalUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === paths.infoPath && scenario === 'unlink failure') throw primary;
      return originalUnlink(target);
    });
    const finished = owner.finish(undefined, { retainRegistration: scenario === 'intentional' });
    if (scenario === 'unlink failure') await assert.rejects(finished, (error) => error === primary);
    else assert.deepEqual(await finished, { state: 'retained' });
    assert.equal(fs.existsSync(paths.infoPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
    assert.equal(readDaemonShutdownReport(paths.baseDir), null);
    assert.equal((await tryAcquireDaemonRegistration(paths)).status, 'busy');
  },
);

test('a spent embedded owner cannot overwrite a same-host successor report', async () => {
  const { paths, owner } = await acquire();
  owner.publish({ ...fields, ownership: 'embedded' });
  await owner.finish();
  const next = await acquire(paths);
  next.owner.publish({ ...fields, ownership: 'embedded', token: 'next-runtime' });
  const outcome = {
    providerReleases: { released: [], pending: [] },
    claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
  };
  await next.owner.finish(outcome, { retainRegistration: true });
  const file = resolveDaemonShutdownReportPath(paths.baseDir);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(owner.finish(outcome));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(readDaemonShutdownReport(paths.baseDir), outcome);
  assert.equal(fs.existsSync(paths.infoPath), true);
  assert.equal(fs.existsSync(paths.lockPath), true);
});
