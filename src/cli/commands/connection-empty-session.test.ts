import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withCapturedStdoutAsync } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import {
  connectionWorkspace,
  createTestClient,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';
import { disconnectCommand } from '../../__tests__/test-utils/host-bound-commands.ts';

// `--session=` names the empty session. Read as an omitted session, it followed the active-session
// pointer, so `disconnect --session=` removed the connection the pointer named for another session.

test('disconnect --session= with no empty-session record keeps the record the pointer names', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connection-empty-session-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: { session: 'Demo', remoteConfigPath, tenant: 'acme', runId: 'run-Demo' },
  });

  const stdout = await withCapturedStdoutAsync(async () => {
    // Every call this client answers throws: the command may not reach the daemon.
    await disconnectCommand({
      positionals: [],
      flags: { json: true, help: false, version: false, stateDir, session: '' },
      client: createTestClient(),
    });
  });

  const payload = JSON.parse(stdout).data;
  assert.equal(payload.connected, false);
  assert.equal(payload.session, '');
  assert.equal(
    readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId,
    'run-Demo',
    'disconnecting the empty session keeps the record of the session the pointer names',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
