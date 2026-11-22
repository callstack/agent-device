import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withCapturedStdoutAsync } from '@agent-device/test-kit';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import {
  connectionWorkspace,
  createTestClient,
} from '../../__tests__/remote-connection.fixtures.ts';
import {
  connectionCommand,
  disconnectCommand,
} from '../../__tests__/test-utils/host-bound-commands.ts';

// Upgrading on a case-insensitive filesystem left the record an older build wrote for `Demo` at the
// name `demo` opens. `connection status --session demo` and `disconnect --session demo` both answered
// `connection_session_mismatch`, so the session could neither report nor drop its own connection.

const RECORDS_DIR = 'remote-connections';

/**
 * Leaves a saved connection for `session` reachable under the name its case-variant opens too, which is
 * what a case-insensitive filesystem does by itself. On such a volume the name `Demo` was written under
 * already IS the name `demo` opens; on a case-sensitive one, a hard link stands in for that fold.
 */
function plantRecordSharedByCaseVariants(options: {
  stateDir: string;
  remoteConfigPath: string;
  session: string;
}): string {
  const recordsDir = path.join(options.stateDir, RECORDS_DIR);
  fs.mkdirSync(recordsDir, { recursive: true });
  const now = new Date().toISOString();
  const written = path.join(recordsDir, `${options.session}.json`);
  fs.writeFileSync(
    written,
    `${JSON.stringify(
      {
        version: 1,
        session: options.session,
        remoteConfigPath: options.remoteConfigPath,
        remoteConfigHash: hashRemoteConfigFile(options.remoteConfigPath),
        tenant: 'acme',
        runId: `run-${options.session}`,
        connectedAt: now,
        updatedAt: now,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const aliased = path.join(recordsDir, `${options.session.toLowerCase()}.json`);
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

for (const [name, run] of [
  ['connection status', connectionCommand],
  ['disconnect', disconnectCommand],
] as const) {
  test(`${name} for a session whose saved-connection name an older build shared reports no connection`, async () => {
    const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
      'agent-device-connection-case-variant-',
    );
    fs.writeFileSync(remoteConfigPath, '{}');
    plantRecordSharedByCaseVariants({
      stateDir,
      remoteConfigPath,
      session: 'Demo',
    });

    const stdout = await withCapturedStdoutAsync(async () => {
      // Every call this client answers throws: neither command may reach the daemon.
      await run({
        positionals: name === 'connection status' ? ['status'] : [],
        flags: { json: true, help: false, version: false, stateDir, session: 'demo' },
        client: createTestClient(),
      });
    });

    const payload = JSON.parse(stdout).data;
    assert.equal(payload.connected, false);
    assert.equal(payload.session, 'demo');
    assert.equal(
      readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId,
      'run-Demo',
      'answering for one session keeps the record the other one owns',
    );
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
}
