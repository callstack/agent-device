import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { storeWithLimrunInstalled } from '../../__tests__/test-utils/limrun-plugin-store.ts';
import { parseJsonOutputs } from '../../__tests__/test-utils/cli-json-outputs.ts';
import { resolveCliSessionPath } from '../auth-session.ts';

// A state root whose CLI session name is a directory cannot receive the login: the publish rename
// fails. Each case approves a device login in a route that must save it before it generates or
// publishes connection state, or reports success, so that failed write is what the command answers
// with — one error result, and no saved connection.
const CLOUD = 'https://cloud.example';
const CLOUD_DAEMON = 'https://bridge.agent-device.dev/api';
const terminals = [process.stdin, process.stdout] as const;
const originalTty = terminals.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));

// The route that names a provider admits its plugin before it authenticates, so Limrun is installed.
vi.mock(
  '@agent-device/plugins/store',
  async (importOriginal) =>
    await storeWithLimrunInstalled(
      importOriginal as () => Promise<typeof import('@agent-device/plugins/store')>,
    ),
);

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

/** The control plane: an approved device login, then a providerless connection profile. */
function stubApprovedDeviceLogin(): void {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
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
            },
          },
        });
      }
      throw new Error(`unexpected request: ${pathname}`);
    }),
  );
}

/**
 * Approves a device login in `argv` where the CLI session name is a directory, and requires the one
 * result to be the failed write: the login the run could not save stopped it before it published
 * connection state or reported success.
 */
async function expectOneFailureWhenTheLoginCannotBeSaved(
  argv: string[],
  prepare?: (project: string) => void,
): Promise<void> {
  stubApprovedDeviceLogin();
  const workspace = makeTempWorkspace();
  const { root, home, project } = workspace;
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(resolveCliSessionPath(stateDir), { recursive: true });
  prepare?.(project);
  try {
    const result = await runCliCapture([...argv, '--state-dir', stateDir, '--json'], {
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
    });

    assert.equal(result.code, 1, result.stdout + result.stderr);
    const outputs = parseJsonOutputs(result.stdout);
    assert.equal(outputs.length, 1, result.stdout);
    const output = outputs[0] as { success?: unknown; error?: { message?: string } };
    assert.equal(output.success, false, result.stdout);
    assert.match(String(output.error?.message), /cli-session\.json/);
    assert.equal(fs.existsSync(path.join(stateDir, 'remote-connections')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Cloud discovery names the provider only after the login, so the login is saved where that provider
// is checked: before the profile is generated.
test.each([
  { route: 'connect cloud', argv: ['connect', 'cloud'] },
  { route: 'plain connect', argv: ['connect'] },
  {
    route: 'connect --daemon-base-url, which discovers its profile too',
    argv: ['connect', '--daemon-base-url', CLOUD_DAEMON, '--tenant', 'acme'],
  },
])(
  '$route stops before it generates a profile when its login cannot be saved',
  async ({ argv }) => {
    await expectOneFailureWhenTheLoginCannotBeSaved([...argv, '--session', 'ci']);
  },
);

// These routes already know their provider where they authenticate, so the auth step saves the login
// it approves: before the profile and connection record of the command that follows.
test.each([
  {
    route: 'connect --remote-config',
    argv: ['connect', '--remote-config', 'remote.json'],
    prepare: (project: string) => {
      fs.writeFileSync(
        path.join(project, 'remote.json'),
        JSON.stringify({
          daemonBaseUrl: CLOUD_DAEMON,
          tenant: 'acme',
          runId: 'run-1',
        }),
      );
    },
  },
  {
    route: 'connect proxy',
    argv: ['connect', 'proxy', '--daemon-base-url', 'https://bridge.agent-device.dev/agent-device'],
  },
  {
    route: 'connect through the proxy endpoint shortcut',
    argv: ['connect', '--daemon-base-url', 'https://bridge.agent-device.dev/agent-device'],
  },
  {
    route: 'connect limrun',
    argv: ['connect', 'limrun', '--daemon-base-url', CLOUD_DAEMON, '--provider-app', 'app.apk'],
  },
])(
  '$route stops before it saves a connection record when its login cannot be saved',
  async ({ argv, prepare }) => {
    await expectOneFailureWhenTheLoginCannotBeSaved([...argv, '--session', 'ci'], prepare);
  },
);

test('auth login answers one error when the approved login cannot be saved', async () => {
  // Explicit `auth login` is outside any deferral: it saves before it reports success.
  await expectOneFailureWhenTheLoginCannotBeSaved(['auth', 'login']);
});
