import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  readRemoteConnectionState,
  removeRemoteConnectionState,
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

test('sessions named Demo and demo keep separate records', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-case-');
  writeRemoteConnectionState({ stateDir, state: recordFor('Demo') });
  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId,
    'run-Demo',
    'reading one session must not return the record the case-variant session wrote',
  );
  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' })?.runId, 'run-demo');
  assert.deepEqual(
    recordsIn(stateDir),
    [ACTIVE_SESSION_FILE, 'demo.json', hashedFileName('Demo')].sort(),
    'a name that cannot be a filename gets its own hashed file, never one two names share',
  );
});

test('sessions named by the lone surrogates U+D800 and U+D801 keep separate records', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-surrogate-');
  writeRemoteConnectionState({ stateDir, state: recordFor('\uD800') });
  writeRemoteConnectionState({ stateDir, state: recordFor('\uD801') });

  assert.equal(readRemoteConnectionState({ stateDir, session: '\uD800' })?.runId, 'run-\uD800');
  assert.equal(readRemoteConnectionState({ stateDir, session: '\uD801' })?.runId, 'run-\uD801');
  assert.deepEqual(
    recordsIn(stateDir),
    [ACTIVE_SESSION_FILE, hashedFileName('\uD800'), hashedFileName('\uD801')].sort(),
    'names that UTF-8 encodes alike must still get different files',
  );
});

test('disconnecting one of two case-variant sessions leaves the other record', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-remove-');
  writeRemoteConnectionState({ stateDir, state: recordFor('Demo') });
  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  removeRemoteConnectionState({ stateDir, session: 'Demo' });

  assert.equal(readRemoteConnectionState({ stateDir, session: 'Demo' }), null);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'demo' })?.runId,
    'run-demo',
    'removing a session must not reach through to the file another session owns',
  );
});

test('a session name that cannot be a filename is stored under its hash', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-hashed-');
  const session = 'team/dev#1';

  writeRemoteConnectionState({ stateDir, state: recordFor(session) });

  assert.deepEqual(recordsIn(stateDir), [hashedFileName(session), ACTIVE_SESSION_FILE].sort());
  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
});

test('a record at the sanitized path that names this session moves to its hashed path', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-legacy-match-');
  const session = 'team/dev#1';
  writeRecordFile(stateDir, sanitizedFileName(session), recordFor(session));

  assert.equal(
    readRemoteConnectionState({ stateDir, session })?.runId,
    `run-${session}`,
    'a record written before hashed paths still serves the session it names',
  );
  assert.deepEqual(
    recordsIn(stateDir),
    [hashedFileName(session)],
    'the record now lives only at the hashed path, and the sanitized name is gone',
  );
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

  const refusal = captureRefusal(() => readRemoteConnectionState({ stateDir, session }));

  assert.equal(refusal.details?.reason, 'connection_session_mismatch');
  assert.equal(refusal.details?.recordPath, legacyPath);
  assert.deepEqual(
    recordsIn(stateDir),
    [hashedFileName(session), sanitizedFileName(session)].sort(),
    'neither record is lost when both claim the same session',
  );
});

test('a record an older build shared with a case-variant session moves to its owner', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-upgrade-');
  plantFileSharedByCaseVariants(stateDir, 'Demo');

  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'demo' }),
    null,
    'the record an older build wrote for Demo is not the demo session connection',
  );
  assert.deepEqual(recordsIn(stateDir), [hashedFileName('Demo')]);

  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });
  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' })?.runId, 'run-demo');
  assert.equal(readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId, 'run-Demo');

  removeRemoteConnectionState({ stateDir, session: 'demo' });
  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' }), null);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId,
    'run-Demo',
    'removing one session must not reach the record the other one owns',
  );
});

for (const [damage, skip] of [
  ['unreadable', runsAsRoot],
  ['unparseable', false],
] as const) {
  test.skipIf(skip)(
    `an ${damage} record an older build shared with a case-variant session is never removed`,
    () => {
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
        assert.equal(
          readRemoteConnectionState({ stateDir, session: 'Demo' }),
          null,
          'a record whose owner is unknown does not serve any session',
        );
        captureRefusal(() => writeRemoteConnectionState({ stateDir, state: recordFor('demo') }));
        captureRefusal(() => removeRemoteConnectionState({ stateDir, session: 'demo' }));
        assert.deepEqual(recordsIn(stateDir), planted, 'no command removed the shared file');
      } finally {
        fs.chmodSync(sharedPath, 0o600);
      }
    },
  );
}

test('a record that fails validation is removed only for the session it names', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-invalid-');
  const foreignPath = writeRecordFile(stateDir, 'demo.json', {
    ...recordFor('other'),
    updatedAt: null,
  });
  const ownPath = writeRecordFile(stateDir, 'other.json', {
    ...recordFor('other'),
    updatedAt: null,
  });

  const refusal = captureRefusal(() => readRemoteConnectionState({ stateDir, session: 'demo' }));
  assert.equal(refusal.details?.reason, 'connection_session_mismatch');
  assert.equal(fs.existsSync(foreignPath), true, 'an invalid record of another session is kept');

  assert.equal(readRemoteConnectionState({ stateDir, session: 'other' }), null);
  assert.equal(fs.existsSync(ownPath), false, 'an invalid record of this session is removed');
});

test('an invalid record of the U+D800 session survives a U+D801 status read', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-invalid-surrogate-');
  const recordPath = writeRecordFile(stateDir, hashedFileName('\uD800'), {
    ...recordFor('\uD800'),
    updatedAt: null,
  });

  assert.equal(readRemoteConnectionState({ stateDir, session: '\uD801' }), null);
  assert.equal(fs.existsSync(recordPath), true);
});

test('a session named by a case alias of the pointer file is stored under its hash', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-pointer-alias-');
  const session = '.ACTIVE-SESSION';
  writeRecordFile(stateDir, `${session}.json`, recordFor(session));

  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
  assert.deepEqual(
    recordsIn(stateDir),
    [ACTIVE_SESSION_FILE, 'demo.json', hashedFileName(session)].sort(),
    'the legacy record moved to its hashed path instead of sitting on the pointer name',
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(stateDir, RECORDS_DIR, ACTIVE_SESSION_FILE), 'utf8')),
    { session: 'demo' },
  );
});

test('a record left on the pointer path moves to its owner before the pointer is written', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-pointer-');
  // A build that sanitized names wrote the session `.active-session` to exactly the pointer path.
  const session = '.active-session';
  writeRecordFile(stateDir, ACTIVE_SESSION_FILE, recordFor(session));

  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
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

test('the last guard names the record it refused and how to clear it', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-mismatch-');
  // A foreign record planted at a session's own path, or one that changed under a command in flight.
  const session = 'team/dev#1';
  const statePath = writeRecordFile(stateDir, hashedFileName(session), recordFor('team:dev#1'));

  const read = captureRefusal(() => readRemoteConnectionState({ stateDir, session }));
  assert.equal(read.code, 'COMMAND_FAILED');
  assert.equal(read.details?.reason, 'connection_session_mismatch');
  assert.equal(read.details?.session, session);
  assert.equal(read.details?.recordPath, statePath);
  assert.ok(
    String(read.details?.hint).includes(statePath),
    'the recovery names the file it wants removed',
  );

  const write = captureRefusal(() =>
    writeRemoteConnectionState({ stateDir, state: recordFor(session) }),
  );
  assert.equal(write.details?.reason, 'connection_session_mismatch');

  const remove = captureRefusal(() => removeRemoteConnectionState({ stateDir, session }));
  assert.equal(remove.details?.reason, 'connection_session_mismatch');
  assert.equal(
    fs.existsSync(statePath),
    true,
    'a refused disconnect must not delete the record it would have overwritten',
  );
});
