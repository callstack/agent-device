import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { parseJsonOutputs } from '../../__tests__/test-utils/cli-json-outputs.ts';
import { readCliSession, resolveCliSessionPath } from '../auth-session.ts';

// A `connect` that learns its provider from the control plane holds the login it approves until that
// provider is admitted, so another auth command can answer for the same state directory while the
// connection-profile request is open. Each case holds that request open, runs an explicit `auth login`
// or `auth logout` in the gap, and then lets the connect resume: the explicit command is the newer
// answer, and the login the connect holds may not overwrite it.
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

const CLI_ENV = {
  AGENT_DEVICE_CLOUD_BASE_URL: CLOUD,
  // A remote shell prints the verification URL and opens no browser.
  SSH_TTY: '/dev/ttys001',
  CI: '',
  GITHUB_ACTIONS: '',
  BUILDKITE: '',
};

/**
 * The open connection-profile request of the pending connect. `hold` is what its handler awaits, so the
 * request stays in flight until the test releases it, and `arrived` says when it got there.
 */
type ProfileGate = {
  hold: () => Promise<void>;
  arrived: Promise<void>;
  release: () => void;
};

function createProfileGate(): ProfileGate {
  let markArrived: () => void = () => {};
  let letGo: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    markArrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  return {
    hold: async () => {
      markArrived();
      await released;
    },
    arrived,
    release: letGo,
  };
}

/**
 * The control plane: each device login is approved with the next id of `sessionIds`, and the connection
 * profile the connect asks for is held at `gate` before it answers.
 */
function stubControlPlane(options: { gate: ProfileGate; sessionIds: readonly string[] }): void {
  let approvals = 0;
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
        const id = options.sessionIds[Math.min(approvals++, options.sessionIds.length - 1)]!;
        return json({
          status: 'approved',
          accessToken: `adc_agent_${id}`,
          cliSession: { id, refreshCredential: `refresh-${id}` },
        });
      }
      if (pathname === '/api/control-plane/connection-profile') {
        await options.gate.hold();
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

/** A stored session whose access has expired, which is what sends a connect to a fresh device login. */
function writeExpiredCliSession(stateDir: string, id: string): void {
  fs.mkdirSync(path.dirname(resolveCliSessionPath(stateDir)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    resolveCliSessionPath(stateDir),
    JSON.stringify({
      version: 1,
      id,
      cloudBaseUrl: CLOUD,
      refreshCredential: `refresh-${id}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    }),
  );
}

function connectWorkspaces() {
  const { root, home, project } = makeTempWorkspace();
  return { root, stateDir: path.join(root, 'state'), home, project };
}

/** Runs one CLI command in this workspace. Used while another command is already in flight. */
function runInWorkspace(
  argv: string[],
  workspace: { stateDir: string; home: string; project: string },
) {
  return runCliCapture([...argv, '--state-dir', workspace.stateDir, '--json'], {
    cwd: workspace.project,
    env: { HOME: workspace.home, ...CLI_ENV },
  });
}

function assertOneSuccess(stdout: string): void {
  const outputs = parseJsonOutputs(stdout) as Array<{ success?: unknown }>;
  assert.equal(outputs.length, 1, stdout);
  assert.equal(outputs[0]?.success, true, stdout);
}

test('an explicit auth login completed while the profile request is open keeps its session', async () => {
  const gate = createProfileGate();
  stubControlPlane({ gate, sessionIds: ['cli-pending', 'cli-explicit'] });
  const workspace = connectWorkspaces();

  try {
    const pending = runInWorkspace(['connect', 'cloud', '--session', 'ci'], workspace);
    await gate.arrived;

    const login = await runInWorkspace(['auth', 'login'], workspace);
    assert.equal(login.code, null, login.stdout + login.stderr);
    assert.equal(readCliSession({ stateDir: workspace.stateDir })?.id, 'cli-explicit');

    gate.release();
    const connect = await pending;

    assertOneSuccess(connect.stdout);
    // The login the explicit command saved is still the stored session: the older approval stood down.
    assert.equal(readCliSession({ stateDir: workspace.stateDir })?.id, 'cli-explicit');
  } finally {
    gate.release();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('an auth logout completed while the profile request is open leaves the state directory signed out', async () => {
  const gate = createProfileGate();
  stubControlPlane({ gate, sessionIds: ['cli-pending'] });
  const workspace = connectWorkspaces();
  // The stored session has expired, which is why the connect goes to a fresh device login at all.
  writeExpiredCliSession(workspace.stateDir, 'cli-expired');

  try {
    const pending = runInWorkspace(['connect', 'cloud', '--session', 'ci'], workspace);
    await gate.arrived;

    const logout = await runInWorkspace(['auth', 'logout'], workspace);
    assert.equal(logout.code, null, logout.stdout + logout.stderr);
    assert.equal(fs.existsSync(resolveCliSessionPath(workspace.stateDir)), false);

    gate.release();
    const connect = await pending;

    assertOneSuccess(connect.stdout);
    // The logout is the newer answer, so the resumed connect writes no session back.
    assert.equal(readCliSession({ stateDir: workspace.stateDir }), null);
  } finally {
    gate.release();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('a connect with no other auth command in flight saves the login it was approved', async () => {
  const gate = createProfileGate();
  stubControlPlane({ gate, sessionIds: ['cli-pending'] });
  const workspace = connectWorkspaces();

  try {
    const pending = runInWorkspace(['connect', 'cloud', '--session', 'ci'], workspace);
    await gate.arrived;
    gate.release();
    const connect = await pending;

    assert.equal(connect.code, null, connect.stdout + connect.stderr);
    assert.equal(readCliSession({ stateDir: workspace.stateDir })?.id, 'cli-pending');
  } finally {
    gate.release();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('a connect whose auth revision cannot be read saves no login', async () => {
  const gate = createProfileGate();
  stubControlPlane({ gate, sessionIds: ['cli-pending'] });
  const workspace = connectWorkspaces();
  // A record of another version cannot say what this state directory's auth state is, and unknown is
  // not proof that nothing changed since, so the held login is not saved on it.
  writeUnreadableAuthRevision(workspace.stateDir);

  try {
    const pending = runInWorkspace(['connect', 'cloud', '--session', 'ci'], workspace);
    await gate.arrived;
    gate.release();
    const connect = await pending;

    assertOneSuccess(connect.stdout);
    assert.equal(readCliSession({ stateDir: workspace.stateDir }), null);
  } finally {
    gate.release();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

function writeUnreadableAuthRevision(stateDir: string): void {
  fs.mkdirSync(path.dirname(resolveCliSessionPath(stateDir)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(path.dirname(resolveCliSessionPath(stateDir)), 'cli-session.revision.json'),
    JSON.stringify({ version: 2, generation: 1 }),
  );
}
