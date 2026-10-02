import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { tryAcquireDaemonRegistration } from '../daemon-registration-owner.ts';
import { resolveDaemonPaths, type DaemonPaths } from '../daemon-resolution.ts';
import { readRegisteredDaemonOwnership } from '../daemon-registration.ts';
import { readDaemonShutdownReport } from '../daemon-shutdown-report.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

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

for (const [pid, startTime, reason] of [
  [999_999_999, 'successor-start', 'replaced'],
  [process.pid, 'recycled-start', 'replaced'],
  [process.pid, undefined, 'unproven'],
  [0, undefined, 'ownerless'],
  [-3, undefined, 'ownerless'],
  [1.5, undefined, 'ownerless'],
  ['7', undefined, 'ownerless'],
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
});
