import { describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
  removeRemoteConnectionState,
  resolveRemoteConnectionDefaults,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from './remote-connection-state.ts';

// A saved connection is stored in a file named after its session. Sanitizing a name that cannot be a
// filename, instead of hashing it, let two names that differ only in case open the same file on a
// case-insensitive filesystem, so one session read and then overwrote another session's record.

const RECORDS_DIR = 'remote-connections';
const ACTIVE_SESSION_FILE = '.active-session.json';

function recordFor(session: string): RemoteConnectionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    session,
    remoteConfigPath: '/profiles/remote.json',
    remoteConfigHash: 'hash',
    tenant: 'acme',
    runId: `run-${session}`,
    connectedAt: now,
    updatedAt: now,
  };
}

/** Writes `contents` straight to `fileName`, as a previous build or another session would have left it. */
function writeRecordFile(
  stateDir: string,
  fileName: string,
  contents: string | Record<string, unknown>,
): string {
  const recordsDir = path.join(stateDir, RECORDS_DIR);
  fs.mkdirSync(recordsDir, { recursive: true });
  const statePath = path.join(recordsDir, fileName);
  const text = typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  fs.writeFileSync(statePath, text, 'utf8');
  return statePath;
}

/** Where a session whose name cannot be a filename is stored: under the hash of its UTF-16 code units. */
function hashedFileName(session: string): string {
  const identity = crypto
    .createHash('sha256')
    .update(Buffer.from(session, 'utf16le'))
    .digest('hex');
  return `~${identity}.json`;
}

/** The file name a build that sanitized names wrote for `session`. */
function sanitizedFileName(session: string): string {
  const safe = session.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  if (safe === session) return `${safe}.json`;
  return `${safe}-${crypto.createHash('sha256').update(session).digest('hex').slice(0, 8)}.json`;
}

function recordsIn(stateDir: string): string[] {
  return fs.readdirSync(path.join(stateDir, RECORDS_DIR)).sort();
}

/**
 * Leaves one legacy file reachable under the names of both `session` and its lower-case variant, which
 * is what a case-insensitive filesystem does by itself. On a case-sensitive one, a hard link stands in
 * for that fold so both names open the same bytes.
 */
function plantFileSharedByCaseVariants(
  stateDir: string,
  session: string,
  contents: string | Record<string, unknown> = recordFor(session),
): string {
  const written = writeRecordFile(stateDir, `${session}.json`, contents);
  const aliased = path.join(path.dirname(written), `${session.toLowerCase()}.json`);
  try {
    fs.linkSync(written, aliased);
  } catch (error) {
    // EEXIST: the volume folds the two names onto the file that is already there.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return written;
}

function captureRefusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected a refusal');
}

const runsAsRoot = process.getuid?.() === 0;

describe.each([
  { first: 'Demo', second: 'demo', files: ['demo.json', hashedFileName('Demo')] },
  {
    first: '\uD800',
    second: '\uD801',
    files: [hashedFileName('\uD800'), hashedFileName('\uD801')],
  },
])('sessions named $first and $second', ({ first, second, files }) => {
  test('keep separate records, and removing one leaves the other', () => {
    const stateDir = mkdtempForTestSync('agent-device-remote-identity-pair-');
    writeRemoteConnectionState({ stateDir, state: recordFor(first) });
    writeRemoteConnectionState({ stateDir, state: recordFor(second) });

    assert.equal(readRemoteConnectionState({ stateDir, session: first })?.runId, `run-${first}`);
    assert.equal(readRemoteConnectionState({ stateDir, session: second })?.runId, `run-${second}`);
    assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE, ...files].sort());

    removeRemoteConnectionState({ stateDir, session: first });
    assert.equal(readRemoteConnectionState({ stateDir, session: first }), null);
    assert.equal(readRemoteConnectionState({ stateDir, session: second })?.runId, `run-${second}`);
  });
});

test('a record at the sanitized path that names this session is read in place and moves on save', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-legacy-match-');
  const session = 'team/dev#1';
  writeRecordFile(stateDir, sanitizedFileName(session), recordFor(session));

  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
  assert.deepEqual(recordsIn(stateDir), [sanitizedFileName(session)], 'a read moved no file');

  writeRemoteConnectionState({ stateDir, state: { ...recordFor(session), runId: 'run-saved' } });
  assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE, hashedFileName(session)].sort());
  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, 'run-saved');
});

test('a record at the sanitized path that names another session is left in place', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-legacy-alias-');
  const session = 'team/dev#1';
  // An older build wrote two sessions to the same name, so the file name proves nothing.
  const legacyPath = writeRecordFile(stateDir, sanitizedFileName(session), recordFor('team:dev#1'));

  assert.equal(readRemoteConnectionState({ stateDir, session }), null);
  writeRemoteConnectionState({ stateDir, state: recordFor(session) });

  assert.equal(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).session, 'team:dev#1');
  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
});

test('a sanitized record whose hashed path is already taken is kept and refused', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-legacy-occupied-');
  const session = 'team/dev#1';
  const legacyPath = writeRecordFile(stateDir, sanitizedFileName(session), recordFor(session));
  writeRecordFile(stateDir, hashedFileName(session), recordFor(session));

  const refusal = captureRefusal(() => removeRemoteConnectionState({ stateDir, session }));

  assert.equal(refusal.details?.reason, 'connection_session_mismatch');
  assert.equal(refusal.details?.recordPath, legacyPath);
  assert.deepEqual(
    recordsIn(stateDir),
    [hashedFileName(session), sanitizedFileName(session)].sort(),
    'neither record is lost when both claim the same session',
  );
});

test('a record an older build shared with a case-variant session moves to its owner on save', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-upgrade-');
  plantFileSharedByCaseVariants(stateDir, 'Demo');

  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' }), null);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId, 'run-Demo');

  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });
  // On a case-sensitive volume the fixture's hard link leaves `Demo.json` as a second name of the
  // moved record. Only the Demo session retires that name, so ignore it here.
  assert.deepEqual(
    recordsIn(stateDir).filter((name) => name !== 'Demo.json'),
    [ACTIVE_SESSION_FILE, 'demo.json', hashedFileName('Demo')].sort(),
  );

  removeRemoteConnectionState({ stateDir, session: 'demo' });
  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' }), null);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId, 'run-Demo');
});

describe.each([
  { damage: 'unreadable', skip: runsAsRoot },
  { damage: 'unparseable', skip: false },
])('an $damage record an older build shared with a case-variant session', ({ damage, skip }) => {
  test.skipIf(skip)('is never removed and serves no session', () => {
    const stateDir = mkdtempForTestSync(`agent-device-remote-identity-${damage}-`);
    const sharedPath =
      damage === 'unreadable'
        ? plantFileSharedByCaseVariants(stateDir, 'Demo')
        : plantFileSharedByCaseVariants(stateDir, 'Demo', '{"session": "Demo",');
    if (damage === 'unreadable') fs.chmodSync(sharedPath, 0o000);
    const planted = recordsIn(stateDir);
    try {
      const refusal = captureRefusal(() =>
        readRemoteConnectionState({ stateDir, session: 'demo' }),
      );
      assert.equal(refusal.details?.reason, 'connection_record_owner_unknown');
      assert.equal(readRemoteConnectionState({ stateDir, session: 'Demo' }), null);
      captureRefusal(() => writeRemoteConnectionState({ stateDir, state: recordFor('demo') }));
      captureRefusal(() => removeRemoteConnectionState({ stateDir, session: 'demo' }));
      assert.deepEqual(recordsIn(stateDir), planted, 'no command removed the shared file');
    } finally {
      fs.chmodSync(sharedPath, 0o600);
    }
  });
});

test('an invalid record of another session at a session path refuses read, save and removal', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-mismatch-');
  // Ownership is settled before shape: a record that fails validation is still another session's.
  const statePath = writeRecordFile(stateDir, 'demo.json', {
    ...recordFor('other'),
    updatedAt: null,
  });

  const read = captureRefusal(() => readRemoteConnectionState({ stateDir, session: 'demo' }));
  assert.equal(read.code, 'COMMAND_FAILED');
  assert.equal(read.details?.reason, 'connection_session_mismatch');
  assert.equal(read.details?.session, 'demo');
  assert.equal(read.details?.recordPath, statePath);
  assert.ok(String(read.details?.hint).includes(statePath), 'the recovery names the file');

  for (const run of [
    () => writeRemoteConnectionState({ stateDir, state: recordFor('demo') }),
    () => removeRemoteConnectionState({ stateDir, session: 'demo' }),
  ]) {
    assert.equal(captureRefusal(run).details?.reason, 'connection_session_mismatch');
  }
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).session, 'other');
});

test('a read reports an invalid record of its session as no connection and keeps it', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-observe-invalid-');
  writeRecordFile(stateDir, 'demo.json', { ...recordFor('demo'), updatedAt: null });
  writeRecordFile(stateDir, 'Team.json', { ...recordFor('Team'), updatedAt: null });
  writeRecordFile(stateDir, ACTIVE_SESSION_FILE, { session: 'demo' });

  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' }), null);
  assert.equal(readActiveConnectionState({ stateDir }), null);
  assert.equal(readRemoteConnectionState({ stateDir, session: 'Team' }), null);
  assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE, 'Team.json', 'demo.json'].sort());
});

test('remote command defaults resolve from an older Demo.json without moving it', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-defaults-');
  const remoteConfigPath = path.join(stateDir, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}');
  writeRecordFile(stateDir, 'Demo.json', {
    ...recordFor('Demo'),
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
  });

  const defaults = resolveRemoteConnectionDefaults({
    stateDir,
    session: 'Demo',
    cwd: stateDir,
    env: {},
  });

  assert.equal(defaults?.flags.session, 'Demo');
  assert.equal(defaults?.flags.remoteConfig, remoteConfigPath);
  assert.deepEqual(recordsIn(stateDir), ['Demo.json']);
});

test('the empty session owns the default.json an older build wrote for it, and default does not', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-empty-');
  writeRecordFile(stateDir, 'default.json', recordFor(''));

  assert.equal(readRemoteConnectionState({ stateDir, session: '' })?.runId, 'run-');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'default' }), null);
  assert.deepEqual(recordsIn(stateDir), ['default.json'], 'a read moved no file');

  writeRemoteConnectionState({ stateDir, state: { ...recordFor(''), runId: 'run-saved' } });
  assert.equal(readRemoteConnectionState({ stateDir, session: '' })?.runId, 'run-saved');
  assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE, hashedFileName('')].sort());
});

test('an EPERM hard-link failure never deletes default.json', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-eperm-');
  // The empty session's older record, which fails validation, at the literal `default` session path.
  const legacyPath = writeRecordFile(stateDir, 'default.json', {
    ...recordFor(''),
    updatedAt: null,
  });
  const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
  });
  try {
    assert.throws(() => removeRemoteConnectionState({ stateDir, session: '' }), {
      code: 'EPERM',
    });
    assert.throws(() => writeRemoteConnectionState({ stateDir, state: recordFor('') }), {
      code: 'EPERM',
    });
  } finally {
    link.mockRestore();
  }
  assert.equal(fs.existsSync(legacyPath), true);
});

test('an empty-session pointer resolves for an unnamed read', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-empty-pointer-');
  writeRecordFile(stateDir, hashedFileName(''), recordFor(''));
  writeRecordFile(stateDir, ACTIVE_SESSION_FILE, { session: '' });

  assert.equal(readActiveConnectionState({ stateDir })?.runId, 'run-');
});

test('the record an older build wrote for .active-session at the pointer path is read, then moved before the pointer write', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-pointer-');
  // A build that sanitized names wrote the session `.active-session` to exactly the pointer path.
  const session = '.active-session';
  writeRecordFile(stateDir, ACTIVE_SESSION_FILE, recordFor(session));

  assert.equal(readActiveConnectionState({ stateDir })?.runId, `run-${session}`);
  assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE], 'the active lookup moved no file');

  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
  assert.equal(readActiveConnectionState({ stateDir })?.runId, 'run-demo');
  assert.deepEqual(
    recordsIn(stateDir),
    [ACTIVE_SESSION_FILE, 'demo.json', hashedFileName(session)].sort(),
  );
});

test('a record of unproven owner on the pointer path refuses the pointer write', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-pointer-foreign-');
  const pointerPath = writeRecordFile(stateDir, ACTIVE_SESSION_FILE, recordFor('team'));

  const refusal = captureRefusal(() =>
    writeRemoteConnectionState({ stateDir, state: recordFor('demo') }),
  );

  assert.equal(refusal.details?.reason, 'connection_session_mismatch');
  assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).session, 'team');
  assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE], 'nothing else was written');
});

describe.each([
  { owner: 'demo', ownSessionRecord: 'demo.json', activeRunId: undefined },
  // `.ACTIVE-SESSION.json` is the older name of `.ACTIVE-SESSION`, so the record looks like that
  // session's. Only the checked move may remove it, and the move refuses the occupied hashed path.
  {
    owner: '.ACTIVE-SESSION',
    ownSessionRecord: hashedFileName('.ACTIVE-SESSION'),
    activeRunId: 'run-.ACTIVE-SESSION',
  },
])(
  'a full record at the pointer path that names $owner',
  ({ owner, ownSessionRecord, activeRunId }) => {
    test('is not deleted by removal of that session', () => {
      const stateDir = mkdtempForTestSync('agent-device-remote-identity-pointer-record-');
      writeRecordFile(stateDir, ownSessionRecord, recordFor(owner));
      const pointerPath = writeRecordFile(stateDir, ACTIVE_SESSION_FILE, {
        ...recordFor(owner),
        runId: 'run-at-pointer',
      });
      assert.equal(readActiveConnectionState({ stateDir })?.runId, activeRunId);
      // On a case-insensitive volume `.ACTIVE-SESSION.json` opens the pointer file. A case-sensitive
      // volume keeps the names apart, so the removal reaches the pointer without the checked move.
      const readFileSync = fs.readFileSync;
      const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((file, ...rest) => {
        if (path.basename(String(file)) === '.ACTIVE-SESSION.json') {
          throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
        }
        return readFileSync(file, ...rest);
      }) as typeof fs.readFileSync);
      try {
        removeRemoteConnectionState({ stateDir, session: owner });
      } finally {
        read.mockRestore();
      }

      assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).runId, 'run-at-pointer');
      assert.deepEqual(recordsIn(stateDir), [ACTIVE_SESSION_FILE]);
    });
  },
);
