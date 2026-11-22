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

/** Writes a record straight to `fileName`, as a previous build or another session would have left it. */
function writeRecordFile(stateDir: string, fileName: string, session: string): string {
  const recordsDir = path.join(stateDir, RECORDS_DIR);
  fs.mkdirSync(recordsDir, { recursive: true });
  const statePath = path.join(recordsDir, fileName);
  fs.writeFileSync(statePath, `${JSON.stringify(recordFor(session), null, 2)}\n`, 'utf8');
  return statePath;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Where a session whose name cannot be a filename is stored: under its own hash. */
function hashedFileName(session: string): string {
  return `~${sha256(session)}.json`;
}

/** The file name a build that sanitized names wrote for `session`. */
function sanitizedFileName(session: string): string {
  const safe = session.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return safe === session ? `${safe}.json` : `${safe}-${sha256(session).slice(0, 8)}.json`;
}

/**
 * Leaves one legacy record reachable under the names of both `session` and its case-variant, which is
 * what a case-insensitive filesystem does by itself. On such a volume the name an older build wrote
 * for `Demo` already IS the name `demo` opens; on a case-sensitive one, a hard link stands in for that
 * fold so both names open the same bytes.
 */
function plantRecordSharedByCaseVariants(stateDir: string, session: string): string {
  const recordsDir = path.join(stateDir, RECORDS_DIR);
  fs.mkdirSync(recordsDir, { recursive: true });
  const written = path.join(recordsDir, `${session}.json`);
  fs.writeFileSync(written, `${JSON.stringify(recordFor(session), null, 2)}\n`, 'utf8');
  const aliased = path.join(recordsDir, `${session.toLowerCase()}.json`);
  try {
    fs.linkSync(written, aliased);
  } catch (error) {
    // EEXIST: the volume folds the two names onto the file that is already there.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.equal(
      fs.readFileSync(aliased, 'utf8'),
      fs.readFileSync(written, 'utf8'),
      'the case-variant name must open the record it shares',
    );
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
    fs.readdirSync(path.join(stateDir, RECORDS_DIR)).sort(),
    [ACTIVE_SESSION_FILE, 'demo.json', hashedFileName('Demo')].sort(),
    'a name that cannot be a filename gets its own hashed file, never one two names share',
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

test('a session that wrote under its hash keeps its record after the shared file is removed', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-alias-gone-');
  const shared = plantRecordSharedByCaseVariants(stateDir, 'Demo');
  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  for (const name of [shared, path.join(path.dirname(shared), 'demo.json')]) {
    fs.rmSync(name, { force: true });
  }

  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'demo' })?.runId,
    'run-demo',
    'a session must keep finding the record it wrote under its hash',
  );
});

test('a session name that cannot be a filename is stored under its hash', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-hashed-');
  const session = 'team/dev#1';

  writeRemoteConnectionState({ stateDir, state: recordFor(session) });

  assert.deepEqual(
    fs.readdirSync(path.join(stateDir, RECORDS_DIR)).sort(),
    [hashedFileName(session), ACTIVE_SESSION_FILE].sort(),
  );
  assert.equal(readRemoteConnectionState({ stateDir, session })?.runId, `run-${session}`);
});

test('a record at the sanitized path is used only when its contents name this session', () => {
  const reusedDir = mkdtempForTestSync('agent-device-remote-identity-legacy-match-');
  const session = 'team/dev#1';
  writeRecordFile(reusedDir, sanitizedFileName(session), session);

  assert.equal(
    readRemoteConnectionState({ stateDir: reusedDir, session })?.runId,
    `run-${session}`,
    'a record written before hashed paths still serves the session it names',
  );

  // One file whose contents name another session: that is what a session finds when an older build
  // wrote two sessions to the same name, so the file name proves nothing and only contents decide.
  const aliasedDir = mkdtempForTestSync('agent-device-remote-identity-legacy-alias-');
  writeRecordFile(aliasedDir, sanitizedFileName(session), 'team:dev#1');

  assert.equal(
    readRemoteConnectionState({ stateDir: aliasedDir, session }),
    null,
    'a record naming another session is not this session record, so nothing is read from it',
  );
  assert.equal(
    fs.existsSync(path.join(aliasedDir, RECORDS_DIR, hashedFileName(session))),
    false,
    'and reading it does not give this session a record of its own',
  );
});

test('a record left on the active-session pointer path is not read as a session record', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-pointer-');
  // A build that sanitized names wrote the session `.active-session` to exactly the path its
  // active-session pointer uses, so that file holds a full connection record for it.
  const session = '.active-session';
  writeRecordFile(stateDir, ACTIVE_SESSION_FILE, session);

  assert.equal(
    readRemoteConnectionState({ stateDir, session }),
    null,
    'the pointer path is never a session record, so the session reads as unconnected',
  );
});

test('a record an older build shared with a case-variant session does not lock that session out', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-upgrade-');
  const sharedPath = plantRecordSharedByCaseVariants(stateDir, 'Demo');
  const planted = fs.readFileSync(sharedPath, 'utf8');

  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'demo' }),
    null,
    'the record an older build named for Demo proves it is not the demo session connection',
  );
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), planted);

  writeRemoteConnectionState({ stateDir, state: recordFor('demo') });

  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' })?.runId, 'run-demo');
  assert.equal(
    fs.existsSync(path.join(stateDir, RECORDS_DIR, hashedFileName('demo'))),
    true,
    'a session whose plain name is taken by another session writes under its hash',
  );
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId,
    'run-Demo',
    'the aliased record still serves the session it names',
  );
  assert.equal(
    fs.readFileSync(sharedPath, 'utf8'),
    planted,
    'writing this session record never rewrites the file the other session owns',
  );

  removeRemoteConnectionState({ stateDir, session: 'demo' });

  assert.equal(readRemoteConnectionState({ stateDir, session: 'demo' }), null);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId,
    'run-Demo',
    'removing one session still must not reach the record the other one owns',
  );
  assert.equal(fs.existsSync(sharedPath), true);
});

test('the last guard names the record it refused and how to clear it', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-mismatch-');
  // A record that reached a session's own path while naming another session — a foreign record someone
  // planted there, or one that changed under a command in flight. Resolution takes the path the hash
  // answers for, so only the contents check can refuse it.
  const session = 'team/dev#1';
  const statePath = writeRecordFile(stateDir, hashedFileName(session), 'team:dev#1');

  const read = captureRefusal(() => readRemoteConnectionState({ stateDir, session }));
  assert.equal(read.code, 'COMMAND_FAILED');
  assert.equal(read.details?.reason, 'connection_session_mismatch');
  assert.equal(read.details?.session, session);
  assert.equal(read.details?.recordPath, statePath);
  assert.match(String(read.details?.hint), /disconnect --session team:dev#1/);
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
