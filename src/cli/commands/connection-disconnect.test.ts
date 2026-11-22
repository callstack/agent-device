import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withCapturedStdoutAsync } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import {
  connectionWorkspace,
  createTestClient,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';
import { disconnectCommand } from '../../__tests__/test-utils/host-bound-commands.ts';

function seedReleasableConnection(prefix: string, session: string) {
  const workspace = connectionWorkspace(prefix);
  fs.writeFileSync(workspace.remoteConfigPath, '{}');
  seedConnectionState({
    stateDir: workspace.stateDir,
    state: {
      session,
      remoteConfigPath: workspace.remoteConfigPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      daemon: { baseUrl: 'https://daemon.example' },
    },
  });
  return workspace;
}

test('disconnect names a lease whose release failed in text and JSON output', async () => {
  const { tempRoot, stateDir } = seedReleasableConnection(
    'agent-device-disconnect-release-failed-',
    'adc-release-failed',
  );
  const client = createTestClient({
    closeSession: async () => ({
      session: 'adc-release-failed',
      identifiers: { session: 'adc-release-failed' },
    }),
    release: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const flags = { help: false, version: false, stateDir, session: 'adc-release-failed' };

  const text = await withCapturedStdoutAsync(async () => {
    await disconnectCommand({ positionals: [], flags: { ...flags, json: false }, client });
  });

  assert.match(text, /Disconnected remote session "adc-release-failed"\./);
  assert.match(
    text,
    /Could not release lease lease-1 \(tenant acme, run run-123\) at https:\/\/daemon\.example: connect ECONNREFUSED\./,
  );
  assert.equal(readRemoteConnectionState({ stateDir, session: 'adc-release-failed' }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const second = seedReleasableConnection(
    'agent-device-disconnect-release-failed-json-',
    'adc-release-failed',
  );
  const json = await withCapturedStdoutAsync(async () => {
    await disconnectCommand({
      positionals: [],
      flags: { ...flags, stateDir: second.stateDir, json: true },
      client,
    });
  });
  const payload = JSON.parse(json).data;
  assert.equal(payload.released, false);
  assert.equal(payload.leaseId, 'lease-1');
  assert.equal(payload.releaseError, 'connect ECONNREFUSED');
  fs.rmSync(second.tempRoot, { recursive: true, force: true });
});

test('disconnect removes a generated profile once no session record uses it', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-disconnect-generated-');
  const generatedPath = path.join(
    stateDir,
    'remote-connections',
    'generated',
    'limrun-shared.json',
  );
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, '{}');
  for (const session of ['generated-a', 'generated-b']) {
    seedConnectionState({
      stateDir,
      state: { session, remoteConfigPath: generatedPath, tenant: 'acme', runId: 'run-123' },
    });
  }
  const disconnect = async (session: string) =>
    await withCapturedStdoutAsync(async () => {
      await disconnectCommand({
        positionals: [],
        flags: { json: true, help: false, version: false, stateDir, session },
        client: createTestClient({}),
      });
    });

  await disconnect('generated-a');
  assert.equal(fs.existsSync(generatedPath), true, 'another session still uses the profile');

  await disconnect('generated-b');
  assert.equal(fs.existsSync(generatedPath), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect keeps a generated profile when the lease release failed', async () => {
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-disconnect-generated-kept-');
  const generatedPath = path.join(stateDir, 'remote-connections', 'generated', 'limrun-kept.json');
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'generated-kept',
      remoteConfigPath: generatedPath,
      tenant: 'acme',
      runId: 'run-123',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
    },
  });

  const output = await withCapturedStdoutAsync(async () => {
    await disconnectCommand({
      positionals: [],
      flags: { json: true, help: false, version: false, stateDir, session: 'generated-kept' },
      client: createTestClient({
        release: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    });
  });

  assert.equal(JSON.parse(output).data.releaseError, 'connect ECONNREFUSED');
  assert.equal(fs.existsSync(generatedPath), true, 'a retry of the release needs the profile');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect treats an already-inactive lease as released without a failure notice', async () => {
  const { tempRoot, stateDir } = seedReleasableConnection(
    'agent-device-disconnect-release-inactive-',
    'adc-release-inactive',
  );

  const text = await withCapturedStdoutAsync(async () => {
    await disconnectCommand({
      positionals: [],
      flags: {
        json: false,
        help: false,
        version: false,
        stateDir,
        session: 'adc-release-inactive',
      },
      client: createTestClient({
        closeSession: async () => ({
          session: 'adc-release-inactive',
          identifiers: { session: 'adc-release-inactive' },
        }),
        release: async () => {
          throw new AppError('UNAUTHORIZED', 'lease expired', { reason: 'LEASE_EXPIRED' });
        },
      }),
    });
  });

  assert.equal(text.trim(), 'Disconnected remote session "adc-release-inactive".');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('disconnect refuses a record it cannot remove before it closes the session or releases the lease', async () => {
  const { tempRoot, stateDir } = seedReleasableConnection(
    'agent-device-disconnect-occupied-session-path-',
    'Demo',
  );
  const recordsDir = path.join(stateDir, 'remote-connections');
  const [hashedName] = fs.readdirSync(recordsDir).filter((name) => name.startsWith('~'));
  assert.ok(hashedName, 'the new build saves Demo at its hashed path');
  const hashedPath = path.join(recordsDir, hashedName);
  // An older build connected Demo under a run of its own and saved it at the name it wrote.
  const legacyPath = path.join(recordsDir, 'Demo.json');
  const legacy = JSON.parse(fs.readFileSync(hashedPath, 'utf8'));
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({ ...legacy, runId: 'run-legacy', leaseId: 'lease-legacy' }),
  );
  let closed = 0;
  let released = 0;

  await assert.rejects(
    disconnectCommand({
      positionals: [],
      flags: { json: true, help: false, version: false, stateDir, session: 'Demo' },
      client: createTestClient({
        closeSession: async () => {
          closed += 1;
          return { session: 'Demo', identifiers: { session: 'Demo' } };
        },
        release: async () => {
          released += 1;
          return { released: true };
        },
      }),
    }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'connection_session_mismatch',
  );

  assert.equal(closed, 0);
  assert.equal(released, 0);
  assert.equal(JSON.parse(fs.readFileSync(hashedPath, 'utf8')).leaseId, 'lease-1');
  assert.equal(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).leaseId, 'lease-legacy');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('an unnamed disconnect removes an invalid default record and disconnects the active session', async () => {
  const { tempRoot, stateDir, remoteConfigPath } = connectionWorkspace(
    'agent-device-disconnect-invalid-default-',
  );
  fs.writeFileSync(remoteConfigPath, '{}');
  seedConnectionState({
    stateDir,
    state: {
      session: 'demo',
      remoteConfigPath,
      tenant: 'acme',
      runId: 'run-demo',
      runtime: { platform: 'android', metroPort: 8081 },
    },
  });
  const recordsDir = path.join(stateDir, 'remote-connections');
  const defaultPath = path.join(recordsDir, 'default.json');
  const demoPath = path.join(recordsDir, 'demo.json');
  const activePath = path.join(recordsDir, '.active-session.json');
  const valid = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
  fs.writeFileSync(defaultPath, JSON.stringify({ ...valid, session: 'default', updatedAt: null }));
  const closed: string[] = [];

  const text = await withCapturedStdoutAsync(async () => {
    await disconnectCommand({
      positionals: [],
      flags: { json: false, help: false, version: false, stateDir },
      client: createTestClient({
        closeSession: async (request) => {
          closed.push(request?.session ?? '');
          return { session: 'demo', identifiers: { session: 'demo' } };
        },
      }),
    });
  });

  assert.equal(text.trim(), 'Disconnected remote session "demo".');
  assert.deepEqual(closed, ['demo']);
  assert.equal(fs.existsSync(defaultPath), false);
  assert.equal(fs.existsSync(demoPath), false);
  assert.equal(fs.existsSync(activePath), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test.each([
  {
    name: 'its own file',
    session: 'demo',
    fileName: 'demo.json',
    record: { session: 'demo', version: 1, runId: 'run-demo', updatedAt: null },
  },
  // An older build saved Demo at the name it wrote, and the record holds only its session.
  {
    name: 'its older pointer-shaped file',
    session: 'Demo',
    fileName: 'Demo.json',
    record: { session: 'Demo' },
  },
])(
  'disconnect removes a record at $name that names its session but fails validation',
  async ({ session, fileName, record }) => {
    const { tempRoot, stateDir } = connectionWorkspace('agent-device-disconnect-invalid-record-');
    const recordsDir = path.join(stateDir, 'remote-connections');
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.writeFileSync(path.join(recordsDir, fileName), JSON.stringify(record));
    fs.writeFileSync(path.join(recordsDir, '.active-session.json'), JSON.stringify({ session }));

    const text = await withCapturedStdoutAsync(async () => {
      await disconnectCommand({
        positionals: [],
        flags: { json: false, help: false, version: false, stateDir, session },
        client: createTestClient(),
      });
    });

    assert.equal(text.trim(), `No remote connection for "${session}".`);
    assert.deepEqual(fs.readdirSync(recordsDir), []);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  },
);

// `--session=` names the empty session. Read as an omitted session, it followed the active-session
// pointer and removed the connection the pointer named for another session.
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
  assert.equal(readRemoteConnectionState({ stateDir, session: 'Demo' })?.runId, 'run-Demo');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
