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

test('a saved connection naming another session is refused rather than reused', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-identity-mismatch-');
  const statePath = writeRecordFile(stateDir, 'demo.json', 'Demo');

  const read = captureRefusal(() => readRemoteConnectionState({ stateDir, session: 'demo' }));
  assert.equal(read.code, 'COMMAND_FAILED');
  assert.equal(read.details?.reason, 'connection_session_mismatch');

  const write = captureRefusal(() =>
    writeRemoteConnectionState({ stateDir, state: recordFor('demo') }),
  );
  assert.equal(write.details?.reason, 'connection_session_mismatch');

  const remove = captureRefusal(() => removeRemoteConnectionState({ stateDir, session: 'demo' }));
  assert.equal(remove.details?.reason, 'connection_session_mismatch');
  assert.equal(
    fs.existsSync(statePath),
    true,
    'a refused disconnect must not delete the record it would have overwritten',
  );
});
