import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCliCapture } from './cli-capture.ts';
import { cloudEnv, connectArgs, stubCloudApi } from './cli-cloud-session.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The admission `src/cli.ts` asks for once, where the invocation resolves its `DaemonPaths`, is what every
 * state-directory read of that invocation hangs off. Two reads happen before a command reaches the daemon
 * client: the active connection defaults can supply the daemon URL and config from that directory, and the
 * upgrade notifier writes into it. `daemon status` reads the root and starts nothing, so these runs decide the
 * admission alone.
 */
test('a CLI run refuses a planted link at its state root before reading anything there', async () => {
  const under = mkdtempForTestSync('agent-device-cli-state-root-link-');
  const outside = path.join(under, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(
    path.join(outside, 'connection.json'),
    '{"session":"chosen-by-another-account"}\n',
  );
  const stateDir = path.join(under, 'state');
  fs.symlinkSync(outside, stateDir);

  const run = await runCliCapture(['daemon', 'status', '--json', '--state-dir', stateDir]);

  assert.equal(run.code, 1);
  assert.match(run.stdout, /Refusing to use the daemon state directory/);
  assert.match(run.stdout, /daemon_state_root_unsafe|is a symbolic link/);
  // The connection state the link points at was never read, and nothing was written through it.
  assert.deepEqual(fs.readdirSync(outside), ['connection.json']);
});

// The shape #4649 reports: a root a plain `mkdir` left at the host's umask default. The run repairs it and
// proceeds, because a mode the owner can change never decides whether a command runs.
test('a CLI run repairs a state root the umask left open, and proceeds', async () => {
  const under = mkdtempForTestSync('agent-device-cli-state-root-repair-');
  const stateDir = path.join(under, 'state');
  const previous = process.umask(0o022);
  try {
    fs.mkdirSync(stateDir);
  } finally {
    process.umask(previous);
  }
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o755);

  const run = await runCliCapture(['daemon', 'status', '--json', '--state-dir', stateDir]);

  assert.equal(run.code, null);
  assert.match(run.stdout, /"state": "stopped"/);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
});

async function runUnderUmask002(...run: Parameters<typeof runCliCapture>) {
  const previous = process.umask(0o002);
  try {
    return await runCliCapture(...run);
  } finally {
    process.umask(previous);
  }
}

test.skipIf(process.platform === 'win32').each([
  { command: 'connect', args: connectArgs },
  { command: 'disconnect', args: ['disconnect', '--json'] },
])('$command creates a missing state root privately under umask 002', async ({ args }) => {
  const under = mkdtempForTestSync('agent-device-cli-state-root-fresh-');
  const parent = path.join(under, 'parent');
  const stateDir = path.join(parent, 'state');
  stubCloudApi();

  const run = await runUnderUmask002(args, {
    env: { ...cloudEnv(), AGENT_DEVICE_STATE_DIR: stateDir },
  });

  assert.equal(run.code, null, run.stdout + run.stderr);
  assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
});

test.skipIf(process.platform === 'win32')(
  'disconnect creates a missing state root named by the saved profile privately under umask 002',
  async () => {
    const under = mkdtempForTestSync('agent-device-cli-state-root-profile-');
    const connectionStateDir = path.join(under, 'state');
    const parent = path.join(under, 'parent');
    const profileStateDir = path.join(parent, 'state');
    const profile = path.join(under, 'remote.json');
    fs.writeFileSync(
      profile,
      JSON.stringify({
        stateDir: profileStateDir,
        daemonBaseUrl: 'https://daemon.example/',
        tenant: 'tenant',
        runId: 'run',
        platform: 'ios',
      }),
    );
    const env = { HOME: under, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'daemon-token' };
    const flags = ['--state-dir', connectionStateDir, '--remote-config', profile];
    const connect = await runCliCapture(['connect', '--session', 'demo', ...flags, '--json'], {
      env,
    });
    assert.equal(connect.code, null, connect.stdout + connect.stderr);
    assert.equal(fs.existsSync(parent), false);

    const run = await runUnderUmask002(['disconnect', '--session', 'demo', '--json'], {
      env: { ...env, AGENT_DEVICE_STATE_DIR: connectionStateDir },
    });

    assert.equal(run.code, null, run.stdout + run.stderr);
    assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
    assert.equal(fs.statSync(profileStateDir).mode & 0o777, 0o700);
  },
);

test.skipIf(process.platform === 'win32').each([0o750, 0o775])(
  'connect tightens a pre-existing owned state root (mode %o) without replacing it',
  async (mode) => {
    const under = mkdtempForTestSync('agent-device-cli-state-root-existing-');
    const stateDir = path.join(under, 'state');
    fs.mkdirSync(stateDir);
    fs.chmodSync(stateDir, mode);
    fs.writeFileSync(path.join(stateDir, 'kept'), 'kept');
    const { ino } = fs.statSync(stateDir);
    stubCloudApi();

    const run = await runCliCapture(connectArgs, {
      env: { ...cloudEnv(), AGENT_DEVICE_STATE_DIR: stateDir },
    });

    assert.equal(run.code, null, run.stdout + run.stderr);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(stateDir).ino, ino);
    assert.equal(fs.readFileSync(path.join(stateDir, 'kept'), 'utf8'), 'kept');
  },
);
