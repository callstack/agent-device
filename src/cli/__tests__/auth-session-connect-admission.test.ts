import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { resolveCliSessionPath } from '../auth-session.ts';

// No plugin is installed in this file. Each case approves a device login and then lets the control
// plane name the provider, so the login is new when the provider is admitted or refused.
const CLOUD = 'https://cloud.example';
const terminals = [process.stdin, process.stdout] as const;
const originalTty = terminals.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));

beforeEach(() => {
  for (const stream of terminals) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
});

afterEach(() => {
  terminals.forEach((stream, index) => {
    const descriptor = originalTty[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  });
  vi.unstubAllGlobals();
});

/** The control plane: an approved device login, then a connection profile naming `leaseProvider`. */
function stubControlPlane(leaseProvider: string | undefined): ReturnType<typeof vi.fn> {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/control-plane/device-auth/start') {
      return json({ deviceCode: 'device', userCode: 'USER', verificationUri: `${CLOUD}/verify` });
    }
    if (pathname === '/api/control-plane/device-auth/poll') {
      return json({
        status: 'approved',
        accessToken: 'adc_agent_login',
        cliSession: { id: 'cli-1', refreshCredential: 'refresh-1' },
      });
    }
    if (pathname === '/api/control-plane/connection-profile') {
      return json({
        ok: true,
        connection: {
          remoteConfigProfile: {
            daemonBaseUrl: 'https://bridge.example.com/agent-device',
            tenant: 'acme',
            runId: 'run-1',
            ...(leaseProvider ? { leaseProvider } : {}),
          },
        },
      });
    }
    throw new Error(`unexpected request: ${pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connect(argv: string[]) {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const result = await runCliCapture(
    ['connect', ...argv, '--session', 'ci', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: {
        HOME: home,
        AGENT_DEVICE_CLOUD_BASE_URL: CLOUD,
        // A remote shell prints the verification URL and opens no browser.
        SSH_TTY: '/dev/ttys001',
        CI: '',
        GITHUB_ACTIONS: '',
        BUILDKITE: '',
      },
    },
  );
  return { root, stateDir, result };
}

test.each([
  { route: 'connect cloud', argv: ['cloud'] },
  { route: 'plain connect', argv: [] },
  {
    route: 'connect --daemon-base-url, where the generic auth step logs in',
    argv: ['--daemon-base-url', 'https://bridge.agent-device.dev/api', '--tenant', 'acme'],
  },
])(
  '$route writes no auth state when the approved login discovers Limrun without its plugin',
  async ({ argv }) => {
    const fetchMock = stubControlPlane('limrun');
    const { root, stateDir, result } = await connect(argv);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.details.reason, 'plugin-not-installed');
    assert.match(error.details.installCommand, /agent-device plugins add @agent-device\/limrun/);
    // The login was approved and the profile was fetched with it, so the refusal came after both.
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    assert.deepEqual(paths, [
      '/api/control-plane/device-auth/start',
      '/api/control-plane/device-auth/poll',
      '/api/control-plane/connection-profile',
    ]);
    assert.equal(fs.existsSync(resolveCliSessionPath(stateDir)), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'auth')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'remote-connections')), false);
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test('connect cloud stores the approved login once when the provider is admitted', async () => {
  stubControlPlane(undefined);
  const writes: string[] = [];
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    writes.push(String(to));
    rename(from, to);
  });

  const { root, stateDir, result } = await connect(['cloud']);
  spy.mockRestore();

  assert.equal(result.code, null, result.stdout + result.stderr);
  const session = JSON.parse(fs.readFileSync(resolveCliSessionPath(stateDir), 'utf8'));
  assert.equal(session.id, 'cli-1');
  assert.equal(session.refreshCredential, 'refresh-1');
  assert.equal(session.cloudBaseUrl, CLOUD);
  assert.equal(writes.filter((file) => file === resolveCliSessionPath(stateDir)).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
