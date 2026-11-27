import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync, withStreamTty } from '@agent-device/test-kit';
import { runCliCapture } from './cli-capture.ts';
import {
  cloudEnv,
  connectArgs,
  hostedDevice,
  sessionName,
  stubCloudApi,
} from './cli-cloud-session.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

test('interactive non-JSON connect establishes a fresh state root privately before the upgrade notifier', async () => {
  const base = cloudEnv();
  const stateDir = path.join(base.AGENT_DEVICE_STATE_DIR, 'interactive-fresh-state');
  const fetchMock = stubCloudApi();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CI', '');
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '');
  const previousUmask = process.platform === 'win32' ? undefined : process.umask(0o002);
  try {
    const result = await withStreamTty(process.stderr, true, async () => {
      return await runCliCapture(
        [
          'connect',
          'cloud',
          '--session',
          sessionName,
          '--platform',
          'ios',
          '--vendor',
          'provider-a',
        ],
        { env: { ...base, AGENT_DEVICE_STATE_DIR: stateDir } },
      );
    });
    assert.equal(result.code, null, result.stderr || result.stdout);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    }
    assert.equal(fetchMock.mock.calls.length, 1);
  } finally {
    if (previousUmask !== undefined) process.umask(previousUmask);
  }
});

test.skipIf(process.platform === 'win32').each([0o775, 0o777])(
  'connect and disconnect refuse a caller-owned %o state root before repair or lock without altering it',
  async (mode) => {
    for (const args of [connectArgs, ['disconnect', '--session', sessionName, '--json']]) {
      const base = cloudEnv();
      const stateDir = path.join(mkdtempForTestSync('cloud-cli-unsafe-root-'), 'state');
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.chmodSync(stateDir, mode);
      const fetchMock = stubCloudApi();
      const result = await runCliCapture(args, {
        env: { ...base, AGENT_DEVICE_STATE_DIR: stateDir },
      });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).error.details.reason, 'daemon_state_root_unsafe');
      assert.equal(JSON.parse(result.stdout).error.details.problem, 'not-private');
      assert.equal(fs.statSync(stateDir).mode & 0o777, mode);
      assert.equal(fetchMock.mock.calls.length, 0);
    }
  },
);

test('pending rewrite during connect provider wait refuses if the locked state root disappears', async () => {
  const base = cloudEnv();
  const stateDir = path.join(mkdtempForTestSync('cloud-reset-mid-connect-'), 'state');
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === '/v1/sessions') {
      fs.rmSync(stateDir, { recursive: true, force: true });
      return Response.json(hostedDevice, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await runCliCapture(connectArgs, {
    env: { ...base, AGENT_DEVICE_STATE_DIR: stateDir },
  });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.details.reason, 'cloud_credential_store_unsafe');
  assert.equal(fs.existsSync(stateDir), false);
});
