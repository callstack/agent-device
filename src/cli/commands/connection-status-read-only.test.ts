import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withCapturedStdoutAsync } from '@agent-device/test-kit';
import { hashRemoteConfigFile } from '@agent-device/remote/remote-connection-state';
import {
  connectionWorkspace,
  createTestClient,
} from '../../__tests__/remote-connection.fixtures.ts';
import { connectionCommand } from '../../__tests__/test-utils/host-bound-commands.ts';

// `connection status` only reports the saved connection. A status read that moved an older build's
// record to its session's own file failed where the records directory could not be written.

test('connection status --session Demo over an older Demo.json leaves the records directory unchanged', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-connection-status-read-only-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  const recordsDir = path.join(stateDir, 'remote-connections');
  fs.mkdirSync(recordsDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(recordsDir, 'Demo.json'),
    `${JSON.stringify({
      version: 1,
      session: 'Demo',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'acme',
      runId: 'run-Demo',
      connectedAt: now,
      updatedAt: now,
    })}\n`,
  );

  const stdout = await withCapturedStdoutAsync(async () => {
    // Every call this client answers throws: status may not reach the daemon.
    await connectionCommand({
      positionals: ['status'],
      flags: { json: true, help: false, version: false, stateDir, session: 'Demo' },
      client: createTestClient(),
    });
  });

  const payload = JSON.parse(stdout).data;
  assert.equal(payload.session, 'Demo');
  assert.equal(payload.runId, 'run-Demo');
  assert.deepEqual(fs.readdirSync(recordsDir), ['Demo.json'], 'status moved no file');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
