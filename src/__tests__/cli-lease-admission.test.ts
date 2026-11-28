import { Readable } from 'node:stream';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { AppError, type DispatchDisclosure } from '@agent-device/kernel/errors';
import { REMOTE_LEASE_IDLE_TTL_MS } from '@agent-device/contracts/lease-scope';
import { assertLeaseAdmissionCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonResponse } from '@agent-device/daemon-client';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { prepareMetroRuntime } from '@agent-device/react-native';
import {
  runCliCapture,
  type CapturedDaemonRequest,
  type CliCaptureOptions,
} from './cli-capture.ts';
import { metroPrepareResult } from './remote-connection.fixtures.ts';

vi.mock('@agent-device/react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/react-native')>()),
  prepareMetroRuntime: vi.fn(),
}));

// A daemon that advertises `lease-admission` checks a reused lease when it admits the command, so the
// CLI sends the command marked as admission-checked and without a heartbeat. The daemon-client
// refuses such a request before the send when `/health` lacks the capability; the daemon refuses an
// inactive lease before dispatch. The fake transport below stands where the daemon-client does.

const PROXY_URL = 'http://proxy.example.test/agent-device';
const STORED_LEASE = 'a1'.repeat(16);

type Workspace = { root: string; home: string; project: string; stateDir: string };

function workspace(
  connection: Partial<RemoteConnectionState> = {},
  remoteConfig: Record<string, unknown> = {},
): Workspace {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfigPath = path.join(project, 'agent.remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify(remoteConfig));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'agent',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: PROXY_URL },
      tenant: 'proxy',
      runId: 'run-agent',
      leaseId: STORED_LEASE,
      leaseBackend: 'android-instance',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'android:mobile:emulator-5554',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
      ...connection,
    },
  });
  return { root, home, project, stateDir };
}

function scopeOf(req: CapturedDaemonRequest | undefined, key: string): unknown {
  return req?.meta?.[key as keyof typeof req.meta] ?? req?.flags?.[key as keyof typeof req.flags];
}

function leaseAnswer(req: CapturedDaemonRequest): DaemonResponse {
  return {
    ok: true,
    data: {
      lease: {
        leaseId: String(scopeOf(req, 'leaseId')),
        tenantId: scopeOf(req, 'tenantId') ?? scopeOf(req, 'tenant'),
        runId: scopeOf(req, 'runId'),
        backend: scopeOf(req, 'leaseBackend'),
        leaseProvider: scopeOf(req, 'leaseProvider'),
        clientId: scopeOf(req, 'clientId'),
        deviceKey: scopeOf(req, 'deviceKey'),
      },
    },
  };
}

type Daemon = Readonly<{
  /** What `/health` advertises; without `lease-admission` a marked request is refused unsent. */
  leaseAdmission?: boolean;
  /** The admission refusal of a command that names the stored lease. */
  refusal?: () => Error;
}>;

/** A fake daemon-client transport in front of a daemon that admits every lease but the stored one. */
function transportTo(daemon: Daemon) {
  return async (
    req: CapturedDaemonRequest,
    options?: { leaseCheckedByAdmission?: true },
  ): Promise<DaemonResponse> => {
    if (options?.leaseCheckedByAdmission && !daemon.leaseAdmission) {
      assertLeaseAdmissionCapability(['script-artifacts']);
    }
    if (req.command === 'lease_allocate' || req.command === 'lease_heartbeat') {
      return leaseAnswer(req);
    }
    if (daemon.refusal && scopeOf(req, 'leaseId') === STORED_LEASE) throw daemon.refusal();
    if (req.command === 'open') return { ok: true, data: { session: req.session } };
    return { ok: true, data: { nodes: [], truncated: false } };
  };
}

function admissionRefusal(dispatched?: DispatchDisclosure): AppError {
  return new AppError('UNAUTHORIZED', 'Lease is not active', {
    reason: 'LEASE_NOT_FOUND',
    ...(dispatched === undefined ? {} : { dispatched }),
  });
}

async function run(
  ws: Workspace,
  argv: string[],
  sendToDaemon: NonNullable<CliCaptureOptions['sendToDaemon']>,
) {
  return await runCliCapture(
    [...argv, '--session', 'agent', '--state-dir', ws.stateDir, '--json'],
    {
      cwd: ws.project,
      env: { HOME: ws.home },
      sendToDaemon,
    },
  );
}

function commandsOf(result: Awaited<ReturnType<typeof run>>): string[] {
  return result.calls.map((call) => call.command);
}

function markedOf(result: Awaited<ReturnType<typeof run>>): boolean[] {
  return result.transportOptions.map(
    (options) => (options as { leaseCheckedByAdmission?: true })?.leaseCheckedByAdmission === true,
  );
}

test.each([
  ['snapshot -i', ['snapshot', '-i'], 'snapshot'],
  ['a proxy open on the stored device', ['open', 'com.example'], 'open'],
])('%s reaches a lease-admission daemon without a heartbeat', async (_name, argv, command) => {
  const ws = workspace();
  const result = await run(ws, argv, transportTo({ leaseAdmission: true }));

  assert.equal(result.code, null, result.stdout);
  assert.deepEqual(commandsOf(result), [command]);
  assert.deepEqual(markedOf(result), [true]);
  assert.equal(scopeOf(result.calls[0], 'leaseId'), STORED_LEASE);
  // Admission renews for the window the heartbeat would have named.
  assert.equal(result.calls[0]?.meta?.leaseTtlMs, REMOTE_LEASE_IDLE_TTL_MS);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test('a daemon without lease admission gets the heartbeat, then the command once more', async () => {
  const ws = workspace();
  const result = await run(ws, ['snapshot'], transportTo({ leaseAdmission: false }));

  assert.equal(result.code, null, result.stdout);
  assert.deepEqual(commandsOf(result), ['snapshot', 'lease_heartbeat', 'snapshot']);
  assert.deepEqual(markedOf(result), [true, false, false]);
  assert.equal(result.calls[2]?.meta?.leaseTtlMs, undefined);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test.each([
  ['succeeds', false],
  ['is refused again and not sent a third time', true],
])(
  'a lease refused at admission is reallocated and the resent command %s',
  async (_name, refusedAgain) => {
    const ws = workspace();
    const admits = transportTo({ leaseAdmission: true });
    const result = await run(ws, ['snapshot'], async (req) => {
      const refused = refusedAgain || scopeOf(req, 'leaseId') === STORED_LEASE;
      if (refused && req.command !== 'lease_allocate') throw admissionRefusal('no');
      return await admits(req);
    });

    assert.equal(result.code, refusedAgain ? 1 : null, result.stdout);
    assert.deepEqual(commandsOf(result), ['snapshot', 'lease_allocate', 'snapshot']);
    const allocated = scopeOf(result.calls[1], 'leaseId');
    assert.notEqual(allocated, STORED_LEASE);
    assert.equal(scopeOf(result.calls[2], 'leaseId'), allocated);
    assert.equal(
      readRemoteConnectionState({ stateDir: ws.stateDir, session: 'agent' })?.leaseId,
      allocated,
    );
    if (refusedAgain) {
      const details = JSON.parse(result.stdout).error.details;
      assert.equal(details.reason, 'LEASE_NOT_FOUND');
      assert.equal(details.dispatched, 'no');
    }

    fs.rmSync(ws.root, { recursive: true, force: true });
  },
);

test.each([
  ['an inactive-lease refusal without dispatch disclosure', () => admissionRefusal(), {}],
  ['an inactive-lease refusal that may have dispatched', () => admissionRefusal('unknown'), {}],
  [
    'a transport timeout',
    () =>
      new AppError('COMMAND_FAILED', 'Daemon request timed out', {
        reason: 'daemon_request_timeout',
        daemonRequestSent: true,
      }),
    {},
  ],
  [
    'a lease scope mismatch',
    () =>
      new AppError('UNAUTHORIZED', 'Lease scope mismatch', {
        reason: 'LEASE_SCOPE_MISMATCH',
        dispatched: 'no',
      }),
    { dispatched: 'no' },
  ],
  // Only the client's own guard proves nothing was sent: a gateway answer can follow a forward.
  [
    'a daemon answer with the unsupported-capability reason',
    () =>
      new AppError('UNSUPPORTED_OPERATION', 'The daemon does not check leases at admission.', {
        reason: 'lease_admission_unsupported',
        dispatched: 'no',
      }),
    { dispatched: 'no' },
  ],
])('%s is never resent', async (_name, refusal, expected) => {
  const ws = workspace();
  const result = await run(ws, ['snapshot'], transportTo({ leaseAdmission: true, refusal }));

  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(commandsOf(result), ['snapshot']);
  const details = JSON.parse(result.stdout).error.details;
  assert.equal(details.reason, refusal().details?.reason);
  if ('dispatched' in expected) assert.equal(details.dispatched, expected.dispatched);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

// A `close` ends the connection's session, so no lease is rented or renewed for it.
test('a close refused for an inactive lease allocates nothing and is not resent', async () => {
  const ws = workspace();
  const result = await run(
    ws,
    ['close'],
    transportTo({ leaseAdmission: true, refusal: admissionRefusal }),
  );

  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(commandsOf(result), ['close']);
  assert.deepEqual(markedOf(result), [false]);
  assert.equal(scopeOf(result.calls[0], 'leaseId'), STORED_LEASE);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test.each<[string, string[], Partial<RemoteConnectionState>]>([
  [
    'a host-allocated macos-app lease',
    ['snapshot'],
    {
      leaseId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      leaseBackend: 'macos-app',
      deviceKey: 'com.example.app@4242',
      platform: 'macos',
    },
  ],
  [
    'a provider lease whose runtime runs lifecycle hooks',
    ['snapshot'],
    { leaseProvider: 'limrun' },
  ],
  ['an install that uploads a local artifact first', ['install', 'com.example', 'app.apk'], {}],
  ['an install from a source', ['install-from-source', 'https://example.com/app.apk'], {}],
  [
    'a stored lease id that is not canonical',
    ['snapshot'],
    { leaseId: STORED_LEASE.toUpperCase() },
  ],
  ['a command naming another run', ['snapshot', '--run-id', 'run-other'], {}],
  ['a command naming another tenant', ['snapshot', '--tenant', 'tenant-other'], {}],
  [
    'a command naming another daemon',
    ['snapshot', '--daemon-base-url', 'http://other.example.test/agent-device'],
    {},
  ],
  ['a remote --save-script open', ['open', 'com.example', '--save-script', 'flow.ad'], {}],
  ['a proxy open naming another device mode', ['open', 'com.example', '--device-mode', 'full'], {}],
  ['a proxy open with no stored device', ['open', 'com.example'], { deviceKey: undefined }],
  ['a batch', ['batch', '--steps', '[{"command":"snapshot","input":{}}]'], {}],
  ['a replay, which reads its script from a path', ['replay', '/dev/null'], {}],
  ['a test run, which reads its scripts from paths', ['test', 'flow.ad'], {}],
])('%s keeps the heartbeat on a lease-admission daemon', async (_name, argv, connection) => {
  const ws = workspace(connection);
  const result = await run(ws, argv, transportTo({ leaseAdmission: true }));

  assert.equal(commandsOf(result)[0], 'lease_heartbeat', result.stdout);
  assert.equal(markedOf(result).includes(true), false);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

// Metro preparation registers the companion tunnel under the connection's lease before the command,
// so the lease is checked first and the tunnel and the app share the live one.
test('an open that prepares Metro replaces an ended lease before the bridge setup', async () => {
  const ws = workspace({}, { metroProxyBaseUrl: 'https://bridge.example.test' });
  const events: string[] = [];
  vi.mocked(prepareMetroRuntime).mockImplementation(async (input) => {
    events.push(`prepare ${input.bridgeScope?.leaseId}`);
    return metroPrepareResult();
  });
  const result = await run(ws, ['open', 'com.example'], async (req) => {
    events.push(`${req.command} ${scopeOf(req, 'leaseId')}`);
    if (req.command === 'lease_heartbeat') throw admissionRefusal();
    // The by-spec allocation names no device; the lease answer does.
    if (req.command === 'lease_allocate') {
      return leaseAnswer({
        ...req,
        meta: { ...req.meta, deviceKey: 'android:mobile:emulator-5554' },
      });
    }
    return { ok: true, data: { session: req.session } };
  });

  assert.equal(result.code, null, result.stdout);
  const live = readRemoteConnectionState({ stateDir: ws.stateDir, session: 'agent' })?.leaseId;
  assert.ok(live && live !== STORED_LEASE);
  assert.deepEqual(events, [
    `lease_heartbeat ${STORED_LEASE}`,
    `lease_allocate ${live}`,
    `prepare ${live}`,
    `open ${live}`,
  ]);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test('a lease scope refusal arrives before fill --text-stdin reads the pipe', async () => {
  const pipe = Readable.from(['piped-secret']);
  const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as typeof process.stdin);
  const ws = workspace();
  const result = await run(ws, ['fill', '@e3', '--text-stdin'], async () => {
    throw new AppError('UNAUTHORIZED', 'Lease scope mismatch', { reason: 'LEASE_SCOPE_MISMATCH' });
  });
  stdin.mockRestore();

  assert.equal(result.code, 1, result.stdout);
  assert.deepEqual(commandsOf(result), ['lease_heartbeat']);
  assert.equal(pipe.readableDidRead, false);

  fs.rmSync(ws.root, { recursive: true, force: true });
});
