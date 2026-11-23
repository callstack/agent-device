import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import * as retry from '@agent-device/host-kit/retry';
import { heldKeyedLockKeys, withKeyedLock } from '@agent-device/kernel/keyed-lock';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as hostCommand from '@agent-device/host-kit/command';
import * as hostProcess from '@agent-device/host-kit/process';
import { mkdtempForTestSync, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { parseDaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import {
  authoringPublication,
  makeIosAppSession,
} from '../../__tests__/support/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/support/screen-recording-live-handle.ts';
import { tenantScopedSessionName } from '../../core/session-tenant-scope.ts';
import type { SessionRef } from '../../core/session-state.ts';
import { getLeaseRegistryExecutionLocks } from '../request-execution-scope.ts';
import {
  startDaemon,
  TENANT,
  SESSION,
  LEASE_TTL_MS,
  type RpcBody,
} from './http-server-session-lease-touch.fixtures.ts';

const UNLEASED = { sessionIsolation: 'none', tenantId: undefined };

let world: Awaited<ReturnType<typeof startDaemon>> | undefined;

beforeEach(async (context) => {
  if (await skipWhenLoopbackUnavailable(context)) return;
  world = await startDaemon();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await world?.close();
  world = undefined;
});

function expectLeaseIdRefusal(body: RpcBody): void {
  expect(body.error?.data, JSON.stringify(body)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH', field: 'leaseId' },
  });
}

test('a refused request writes no event into the leased session, and the owner request does', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);

  expectLeaseIdRefusal(await world.send('snapshot', [], {}));
  expect(await world.requestEvents(world.sessionName)).toEqual([]);

  const snapshot = await world.send('snapshot', [], world.owner);
  expect(snapshot.result?.ok, JSON.stringify(snapshot)).toBe(true);
  expect(await world.requestEvents(world.sessionName)).toEqual([
    'request.started',
    'request.finished',
  ]);
});

test.each([
  ['no lease id', {}],
  ['a lease id that is not active', { leaseId: 'f'.repeat(32) }],
])('a close with %s does not end an expired leased session', async (_name, scope) => {
  if (!world) return;
  const ref = world.publishLeasedSession(world.sessionName);
  world.passLeaseDeadline();

  const closed = await world.send('close', [], scope);

  expect(closed.error?.data, JSON.stringify(closed)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_SESSION_MISMATCH' },
  });
  expect(JSON.stringify(closed)).not.toContain(world.leaseId);
  expect(JSON.stringify(closed)).not.toContain('endedLeases');
  expect(world.sessionStore.lookup(world.sessionName)?.lifetime).toBe(ref.lifetime);
  expect(world.expiryTeardown).not.toHaveBeenCalled();
  expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
  expect(world.runtime.inspectFacts).not.toHaveBeenCalled();
  expect(await world.requestEvents(world.sessionName)).toEqual([]);
});

test('a new owner opens the session right after the lease deadline, before the sweep', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);
  // Allocated before the deadline, so no registry call has noticed the expiry yet.
  const successor = world.allocateOtherClient('ios:mobile:SIM-002');
  world.passLeaseDeadline();

  const opened = await world.send('open', ['com.example.app'], successor);

  expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
  expect(world.sessionStore.get(world.sessionName)?.lease?.leaseId).toBe(successor.leaseId);
  expect(JSON.stringify(opened)).not.toContain(world.leaseId);
  expect(JSON.stringify(opened)).not.toContain('endedLeases');
  expect(await world.requestEvents(world.sessionName)).toEqual([
    'request.started',
    'request.finished',
  ]);
  // The open ended the expired session under its own locks, so the lease-end owner found none.
  expect(world.requestTeardown.stopSnapshotHelper).toHaveBeenCalledTimes(1);
  await world.expiryOwnerSettled();
  expect(world.expiryTeardown).not.toHaveBeenCalled();
});

test('a successor open keeps its lease while the expired session teardown is pending', async () => {
  const daemon = world;
  if (!daemon) return;
  daemon.publishLeasedSession(daemon.sessionName);
  const successor = daemon.allocateOtherClient('ios:mobile:SIM-002', LEASE_TTL_MS + 2);
  daemon.passLeaseDeadline();
  const originalExpiry = daemon.leaseRegistry.inspectActiveLease(successor.leaseId)?.expiresAt;
  const teardownEntered = deferred();
  const releaseTeardown = deferred();
  daemon.requestTeardown.stopSnapshotHelper.mockImplementationOnce(async () => {
    teardownEntered.resolve();
    await releaseTeardown.promise;
  });

  const open = daemon.send('open', ['com.example.app'], successor);
  let protectedExpiry: number | undefined;
  try {
    await Promise.race([
      teardownEntered.promise,
      open.then((response) => {
        throw new Error(`Open finished before teardown: ${JSON.stringify(response)}`);
      }),
    ]);
    daemon.passLeaseDeadline();
    daemon.passLeaseDeadline();
    protectedExpiry = daemon.leaseRegistry.inspectActiveLease(successor.leaseId)?.expiresAt;
  } finally {
    releaseTeardown.resolve();
    await open;
  }

  const opened = await open;
  expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
  expect(protectedExpiry).toBeGreaterThan(originalExpiry ?? Infinity);
  expect(daemon.sessionStore.get(daemon.sessionName)?.lease?.leaseId).toBe(successor.leaseId);
  await daemon.expiryOwnerSettled();
  expect(daemon.expiryTeardown).not.toHaveBeenCalled();
});

test('a successor open cannot use a lease id reissued during the expired session teardown', async () => {
  const daemon = world;
  if (!daemon) return;
  daemon.publishLeasedSession(daemon.sessionName);
  const successor = daemon.allocateOtherClient('ios:mobile:SIM-002');
  const replacement = { ...successor, runId: 'run-c', clientId: 'client-c' };
  daemon.passLeaseDeadline();
  let released = false;
  daemon.requestTeardown.stopSnapshotHelper.mockImplementationOnce(async () => {
    await Promise.resolve();
    released = daemon.leaseRegistry.releaseLease(successor).released;
    daemon.leaseRegistry.putHostLease(successor.leaseId, replacement);
  });

  const opened = await daemon.send('open', ['com.example.app'], successor);

  expect(released).toBe(true);
  expect(opened.error?.data, JSON.stringify(opened)).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'LEASE_NOT_FOUND' },
  });
  expect(daemon.sessionStore.get(daemon.sessionName)).toBeUndefined();
  expect(daemon.leaseRegistry.inspectActiveLease(successor.leaseId)?.runId).toBe(replacement.runId);
  await daemon.expiryOwnerSettled();
});

test('a new owner that lease admission would refuse does not end the expired session', async () => {
  if (!world) return;
  const ref = world.publishLeasedSession(world.sessionName);
  const { clientId: _omitted, ...successor } = world.allocateOtherClient('ios:mobile:SIM-002');
  world.passLeaseDeadline();

  // A proxy open of a new session needs the client id.
  const opened = await world.send('open', ['com.example.app'], successor);

  expect(opened.error?.data?.code, JSON.stringify(opened)).toBe('INVALID_ARGS');
  expect(world.sessionStore.lookup(world.sessionName)?.lifetime).toBe(ref.lifetime);
  expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
});

test('an unscoped open cannot replace an expired leased session', async () => {
  if (!world) return;
  const ref = world.publishLeasedSession(SESSION);
  const { leaseId } = world.allocateOtherClient('ios:mobile:SIM-002');
  world.passLeaseDeadline();

  const opened = await world.send('open', ['com.example.app'], {
    leaseId,
    tenantId: undefined,
    sessionIsolation: 'none',
  });

  expect(world.sessionStore.lookup(SESSION)?.lifetime).toBe(ref.lifetime);
  expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
  expectLeaseIdRefusal(opened);
});

test.each([
  {
    command: 'snapshot',
    positionals: [],
    meta: { clientId: undefined },
    error: { code: 'UNAUTHORIZED', details: { reason: 'LEASE_SCOPE_REQUIRED' } },
  },
  {
    command: 'open',
    positionals: ['com.example.app'],
    meta: { leaseTtlMs: 1 },
    error: { code: 'INVALID_ARGS' },
  },
])(
  'a successor that cannot heartbeat on $command leaves the expired session intact',
  async ({ command, positionals, meta, error }) => {
    if (!world) return;
    const ref = world.publishLeasedSession(world.sessionName);
    const successor = world.allocateOtherClient('ios:mobile:SIM-002');
    world.passLeaseDeadline();

    const response = await world.send(command, positionals, { ...successor, ...meta });

    expect(world.sessionStore.lookup(world.sessionName)?.lifetime).toBe(ref.lifetime);
    expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
    expect(response.error?.data, JSON.stringify(response)).toMatchObject(error);
  },
);

test.each([
  {
    failure: 'process has stopped',
    processAlive: false,
    details: { reason: 'MACOS_APP_LEASE_DENIED', rule: 'process' },
  },
  {
    failure: 'lease expires during PID lookup',
    processAlive: true,
    details: { reason: 'LEASE_SESSION_MISMATCH', field: 'leaseId' },
  },
])(
  'a macOS app successor leaves the expired session intact when the $failure',
  async ({ processAlive, details }) => {
    const daemon = world;
    if (!daemon) return;
    const ref = daemon.publishLeasedSession(daemon.sessionName);
    const bundleId = 'com.example.app';
    const pid = 12345;
    const leaseId = 'b'.repeat(32);
    const successor = {
      leaseId,
      tenantId: TENANT,
      runId: 'run-b',
      leaseBackend: 'macos-app',
      deviceKey: `${bundleId}@${pid}`,
    } as const;
    daemon.leaseRegistry.putHostLease(leaseId, { ...successor, ttlMs: 2 * LEASE_TTL_MS });
    const { isProcessAlive } = hostProcess;
    vi.spyOn(hostProcess, 'isProcessAlive').mockImplementation((observedPid) =>
      observedPid === pid ? processAlive : isProcessAlive(observedPid),
    );
    if (processAlive) {
      const { runCmd } = hostCommand;
      vi.spyOn(hostCommand, 'runCmd').mockImplementation(async (command, args, options) => {
        if (command !== '/usr/bin/lsappinfo') return await runCmd(command, args, options);
        await Promise.resolve();
        daemon.passLeaseDeadline();
        return { exitCode: 0, stderr: '', stdout: `bundleID="${bundleId}"` };
      });
    }
    daemon.passLeaseDeadline();

    const opened = await daemon.send('open', [bundleId], successor, {
      flags: { platform: 'macos' },
    });

    expect(daemon.sessionStore.lookup(daemon.sessionName)?.lifetime).toBe(ref.lifetime);
    expect(daemon.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
    expect(opened.error?.data, JSON.stringify(opened)).toMatchObject({
      code: 'UNAUTHORIZED',
      details,
    });
  },
);

test('doctor with the lease id after the deadline leaves the session to the lease-end owner', async () => {
  if (!world) return;
  const ref = world.publishLeasedSession(world.sessionName);
  world.passLeaseDeadline();

  await world.send('doctor', [], world.owner);

  expect(world.requestTeardown.stopSnapshotHelper).not.toHaveBeenCalled();
  await world.expiryOwnerSettled();
  expect(world.expiryTeardown).toHaveBeenCalledTimes(1);
  expect(world.expiryTeardown.mock.calls[0]?.[0].lifetime).toBe(ref.lifetime);
});

test('the owner request after the deadline ends its own expired session', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);
  world.passLeaseDeadline();

  const snapshot = await world.send('snapshot', [], world.owner);

  expect(snapshot.error?.data?.code, JSON.stringify(snapshot)).toBe('UNAUTHORIZED');
  expect(snapshot.error?.data?.details?.reason).not.toBe('LEASE_SESSION_MISMATCH');
  expect(world.sessionStore.get(world.sessionName)).toBeUndefined();
});

test('devices still checks the recording of a session that holds no lease', async () => {
  if (!world) return;
  const session = makeIosAppSession(world.sessionName, {
    sessionScope: { kind: 'tenant', id: TENANT },
  });
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    runnerSessionId: 'runner-0',
  });
  world.sessionStore.publish(world.sessionName, session);

  const devices = await world.send('devices', [], {});

  expect(world.observeRunnerSession).toHaveBeenCalledTimes(1);
  expect(devices.error?.message, JSON.stringify(devices)).toBe(
    'iOS runner session restarted during recording',
  );
});

test('devices with no lease id stays detached from a leased session and its recording', async () => {
  if (!world) return;
  const { session } = world.publishLeasedSession(world.sessionName);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    runnerSessionId: 'runner-0',
  });

  const devices = await world.send('devices', [], {});

  expect(devices.result?.ok, JSON.stringify(devices)).toBe(true);
  expect(world.observeRunnerSession).not.toHaveBeenCalled();
  expect(session.screenRecording.handle.inspect().invalidatedReason).toBeUndefined();
  expect(await world.requestEvents(world.sessionName)).toEqual([]);

  // The owner's command still checks the recording: the runner restarted, so it is refused.
  const snapshot = await world.send('snapshot', [], world.owner);
  expect(world.observeRunnerSession).toHaveBeenCalledTimes(1);
  expect(snapshot.error?.message, JSON.stringify(snapshot)).toBe(
    'iOS runner session restarted during recording',
  );
});

test('a pre-admission policy refusal leaves the current journal empty', async () => {
  if (!world) return;
  await world.close();
  world = await startDaemon(
    parseDaemonPolicy({ version: 1, commands: { deny: ['capabilities'] } }, '/policy.json'),
  );
  world.sessionStore.publish(world.sessionName, makeIosAppSession(world.sessionName));

  const refused = await world.send('capabilities', [], {});
  expect(refused.error?.data?.details?.reason).toBe('DAEMON_POLICY_DENIED');

  const events = await world.send('events', [], {});
  expect(events.result?.ok).toBe(true);
  expect(events.result?.data?.events).toEqual([]);
});

test('events shows the start and failed finish when an invalidated recording blocks capabilities', async () => {
  if (!world) return;
  const { session } = world.publishLeasedSession(world.sessionName);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    runnerSessionId: 'runner-0',
  });

  const refused = await world.send('capabilities', [], world.owner);
  expect(world.observeRunnerSession).toHaveBeenCalledTimes(1);
  expect(refused.error?.data?.code).toBe('COMMAND_FAILED');

  const events = await world.send('events', [], world.owner);
  expect(events.result?.ok).toBe(true);
  expect(events.result?.data?.events).toMatchObject([
    { command: 'capabilities', kind: 'request.started' },
    {
      command: 'capabilities',
      kind: 'request.finished',
      status: 'error',
      details: { code: 'COMMAND_FAILED' },
    },
  ]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each([
  { scenario: 'leased', leased: true, openBeforeDispatch: false },
  { scenario: 'unleased', leased: false, openBeforeDispatch: false },
  { scenario: 'opened leased before dispatch', leased: true, openBeforeDispatch: true },
  { scenario: 'opened unleased before dispatch', leased: false, openBeforeDispatch: true },
])(
  'events shows the doctor start for a session that is $scenario while the toolchain check is pending',
  async ({ leased, openBeforeDispatch }) => {
    const daemon = world;
    if (!daemon) return;
    const { owner, sessionStore, hooks } = daemon;
    const sessionName = leased ? daemon.sessionName : SESSION;
    const scope = leased ? owner : { sessionIsolation: 'none', tenantId: undefined };
    if (openBeforeDispatch) {
      hooks.beforeDispatch = async () => {
        hooks.beforeDispatch = undefined;
        const opened = await daemon.send('open', ['com.example.app'], scope);
        expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
        expect(sessionStore.get(sessionName)?.lease?.leaseId).toBe(
          leased ? owner.leaseId : undefined,
        );
      };
    } else if (leased) {
      daemon.publishLeasedSession(sessionName);
    } else {
      sessionStore.publish(sessionName, makeIosAppSession(sessionName));
    }
    const enteredToolchain = deferred();
    const releaseToolchain = deferred();
    vi.mocked(daemon.hostDiagnostics.toolchainCheck).mockImplementation(async () => {
      enteredToolchain.resolve();
      await releaseToolchain.promise;
      return undefined;
    });

    const doctor = daemon.send('doctor', [], scope);
    try {
      await Promise.race([
        enteredToolchain.promise,
        doctor.then((response) => {
          throw new Error(
            `Doctor finished before its toolchain check: ${JSON.stringify(response)}`,
          );
        }),
      ]);

      const events = await daemon.send('events', [], scope);

      expect(events.result?.ok).toBe(true);
      expect(events.result?.data?.events).toContainEqual(
        expect.objectContaining({ command: 'doctor', kind: 'request.started' }),
      );
    } finally {
      releaseToolchain.resolve();
      await doctor;
    }
    expect((await doctor).result?.ok).toBe(true);
    expect(await daemon.requestEvents(sessionName, 'doctor')).toEqual([
      'request.started',
      'request.finished',
    ]);
  },
);

// `apps` needs a lease of its own to reach dispatch, so it sends the lease of another client.
test.each([
  ['doctor', false],
  ['events', false],
  ['capabilities', false],
  ['apps', true],
] as const)(
  '%s without the session lease id returns nothing from a leased session opened after its admission',
  async (command, sendsOtherLease) => {
    if (!world) return;
    const { hooks, publishLeasedSession, sessionName } = world;
    const scope = sendsOtherLease ? world.allocateOtherClient('ios:mobile:SIM-002') : {};
    hooks.beforeDispatch = () => {
      publishLeasedSession(sessionName);
    };

    const response = await world.send(command, [], scope);
    if (command === 'events') {
      expect(response.error?.data?.code).toBe('SESSION_NOT_FOUND');
    } else {
      expectLeaseIdRefusal(response);
    }

    expect(world.hostDiagnostics.deviceChecks).not.toHaveBeenCalled();
    expect(world.runtime.inspectFacts).not.toHaveBeenCalled();
    // The request arrived at an empty address, and still leaves no finished event for the new session.
    expect(await world.requestEvents(sessionName)).not.toContain('request.finished');
    if (!sendsOtherLease) expect(await world.requestEvents(sessionName)).toEqual([]);
  },
);

test('close and reopen at one address give a second lease a fresh journal', async () => {
  if (!world) return;
  const { owner, send } = world;
  const opened = await send('open', ['com.example.app'], owner);
  expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
  const firstPath = String(opened.result?.data?.eventLogPath);
  const firstPage = await send('events', ['1'], owner);
  expect(firstPage.result?.data).toMatchObject({
    path: firstPath,
    limit: 1,
    nextCursor: '1',
    events: [{ command: 'open', kind: 'request.started' }],
  });

  const closed = await send('close', [], owner);
  expect(closed.result?.ok, JSON.stringify(closed)).toBe(true);
  const secondOwner = world.allocateOtherClient();
  const reopened = await send('open', ['com.example.app'], secondOwner);
  expect(reopened.result?.ok, JSON.stringify(reopened)).toBe(true);
  const secondPage = await send('events', [], secondOwner);
  expect(secondPage.result?.data).toMatchObject({
    path: reopened.result?.data?.eventLogPath,
    events: [
      { command: 'open', kind: 'request.started' },
      { command: 'open', kind: 'action.recorded' },
      { command: 'open', kind: 'request.finished' },
    ],
  });
  expect(secondPage.result?.data?.path).not.toBe(firstPath);
  expectLeaseIdRefusal(await send('events', [], owner));
  await world.sessionStore.flushEvents();
  const retiredEvents = fs.readFileSync(firstPath, 'utf8').trim().split('\n');
  expect(JSON.parse(retiredEvents.at(-1)!)).toMatchObject({
    command: 'close',
    kind: 'request.finished',
    status: 'ok',
  });
});

test.each(['doctor', 'capabilities', 'artifacts'] as const)(
  '%s leaves no start when a leased replacement opens before the handler read',
  async (command) => {
    const daemon = world;
    if (!daemon) return;
    const { owner, sessionName, sessionStore, hooks } = daemon;
    const ref = sessionStore.publish(
      sessionName,
      makeIosAppSession(sessionName, { sessionScope: { kind: 'tenant', id: TENANT } }),
    );
    hooks.beforeDispatch = async () => {
      hooks.beforeDispatch = undefined;
      const closed = await daemon.send('close', [], UNLEASED, { session: sessionName });
      expect(closed.result?.ok, JSON.stringify(closed)).toBe(true);
      const opened = await daemon.send('open', ['com.example.app'], owner);
      expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
      const current = sessionStore.lookup(sessionName);
      expect(current?.lifetime).not.toBe(ref.lifetime);
      expect(current?.session.lease?.leaseId).toBe(owner.leaseId);
    };

    expectLeaseIdRefusal(await daemon.send(command, [], {}));

    const events = await daemon.send('events', [], owner);
    expect(events.result?.ok, JSON.stringify(events)).toBe(true);
    expect(events.result?.data?.events).not.toContainEqual(
      expect.objectContaining({ command, kind: 'request.started' }),
    );
  },
);

test('devices with no lease id is still refused at the address of a macos-app leased session', async () => {
  if (!world) return;
  const { session } = world.publishLeasedSession(world.sessionName, 'macos-app');

  const devices = await world.send('devices', [], {});

  // The app lease admits only the commands that opt into it, and `devices` does not.
  expect(devices.result, JSON.stringify(devices)).toBeUndefined();
  expect(devices.error?.data?.code).toBe('INVALID_ARGS');
  expect(session.lease?.backend).toBe('macos-app');
});

test('devices with no lease id delivers no script of a leased session that records one', async () => {
  if (!world) return;
  const { session } = world.publishLeasedSession(world.sessionName);
  session.scriptPublication = authoringPublication('armed', { remote: true });
  // The owner records an action while `devices` runs.
  world.hooks.beforeDispatch = () => {
    session.actions.push({ ts: Date.now(), command: 'home', positionals: [], flags: {} });
  };

  const devices = await world.send('devices', [], {});

  expect(devices.result?.ok, JSON.stringify(devices)).toBe(true);
  expect(JSON.stringify(devices)).not.toContain('publication-0001');
  expect(session.scriptPublication).toEqual(authoringPublication('armed', { remote: true }));
});

test('capabilities with no lease id reads nothing from a leased session opened during its device selection', async () => {
  if (!world) return;
  const { hooks, publishLeasedSession, sessionName } = world;
  hooks.duringDeviceSelection = () => {
    publishLeasedSession(sessionName);
  };
  // The runtime cannot read the foreground app here, so only a session app would list `appstate`.
  const inspectFacts = world.runtime.inspectFacts.getMockImplementation()!;
  world.runtime.inspectFacts.mockImplementation(async (device) => {
    const facts = await inspectFacts(device);
    const unavailable = { available: false, reason: 'unsupported-device-kind' } as const;
    return {
      ...facts,
      operations: { ...facts.operations, ensureReady: { available: true }, appState: unavailable },
    };
  });

  const capabilities = await world.send('capabilities', [], {}, { flags: { platform: 'ios' } });

  expect(capabilities.result?.ok, JSON.stringify(capabilities)).toBe(true);
  expect(world.sessionStore.get(sessionName)).toBeDefined();
  // `appstate` is available only through the app of the session.
  expect(JSON.stringify(capabilities.result?.data)).not.toContain('appstate');
});

test('doctor with the lease id reports its leased session', async () => {
  if (!world) return;
  world.publishLeasedSession(world.sessionName);

  const doctor = await world.send('doctor', [], world.owner);

  expect(doctor.result?.ok, JSON.stringify(doctor)).toBe(true);
  expect(JSON.stringify(doctor.result?.data)).toContain(world.sessionName);
  expect(world.hostDiagnostics.deviceChecks).toHaveBeenCalledTimes(1);
  expect(await world.requestEvents(world.sessionName)).toEqual([
    'request.started',
    'request.finished',
  ]);
});

function writeSuite(script = 'context platform=ios\nwait 0\n'): {
  flags: Record<string, unknown>;
  positionals: string[];
} {
  const root = mkdtempForTestSync('agent-device-session-lease-touch-suite-');
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, script);
  return {
    positionals: [scriptPath],
    flags: {
      recordVideo: true,
      replayScriptSources: [{ entry: scriptPath, files: { [scriptPath]: script } }],
    },
  };
}

// A direct RPC caller chooses the suite session and request id, and so the attempt address.
const SUITE_SESSION = 'suite';
const SUITE_REQUEST_ID = 'chosen';
const attemptAddress = (session = tenantScopedSessionName(TENANT, SUITE_SESSION)): string =>
  `${session}:test:${SUITE_REQUEST_ID}:1-flow:attempt-1`;

test('a test suite of another client neither records nor closes a leased session at its attempt address', async () => {
  if (!world) return;
  const ref = world.publishLeasedSession(attemptAddress());
  const suite = writeSuite();

  const response = await world.send(
    'test',
    suite.positionals,
    { ...world.allocateOtherClient('ios:mobile:SIM-002'), requestId: SUITE_REQUEST_ID },
    { session: SUITE_SESSION, flags: suite.flags },
  );

  expect(JSON.stringify(response)).toContain('LEASE_SESSION_MISMATCH');
  const attempt = world.sessionStore.lookup(attemptAddress());
  expect(attempt?.lifetime).toBe(ref.lifetime);
  expect(attempt?.session.screenRecording).toBeUndefined();
  expect(world.runtime.bind).not.toHaveBeenCalled();
});

test('a test suite with the lease id runs on and closes its leased attempt session', async () => {
  if (!world) return;
  world.publishLeasedSession(attemptAddress());
  const suite = writeSuite();

  const response = await world.send(
    'test',
    suite.positionals,
    { ...world.owner, requestId: SUITE_REQUEST_ID },
    { session: SUITE_SESSION, flags: { ...suite.flags, recordVideo: false } },
  );

  expect(response.result?.data, JSON.stringify(response)).toMatchObject({ passed: 1, failed: 0 });
  expect(world.sessionStore.get(attemptAddress())).toBeUndefined();
});

test('a leased reopen of a live unleased session refuses before binding the launch runtime', async () => {
  if (!world) return;
  const { sessionStore, runtime, owner } = world;
  const unleased = await world.send('open', ['com.example.app'], UNLEASED);
  expect(unleased.result?.ok, JSON.stringify(unleased)).toBe(true);
  const incumbent = sessionStore.lookup(SESSION)!;
  expect(incumbent.session.lease).toBeUndefined();
  runtime.bind.mockClear();

  expectLeaseIdRefusal(
    await world.send('open', ['com.example.other'], { ...owner, sessionIsolation: 'none' }),
  );
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(sessionStore.lookup(SESSION)?.lifetime).toBe(incumbent.lifetime);

  const reopened = await world.send('open', ['com.example.other'], UNLEASED);
  expect(reopened.result?.ok, JSON.stringify(reopened)).toBe(true);
  expect(sessionStore.lookup(SESSION)?.lifetime).toBe(incumbent.lifetime);
});

test('first open commits its script revision under the session lock before close and replacement', async () => {
  const daemon = world;
  if (!daemon) return;
  const { sessionStore, leaseRegistry, hooks } = daemon;
  const reachedDispatch = deferred();
  const continueDispatch = deferred();
  const realWrite = sessionStore.writeRemoteScriptVersion.bind(sessionStore);
  const written: SessionRef[] = [];
  vi.spyOn(sessionStore, 'writeRemoteScriptVersion').mockImplementation((ref) => {
    expect(heldKeyedLockKeys(getLeaseRegistryExecutionLocks(leaseRegistry))).toContain(
      `session:${SESSION}`,
    );
    written.push(ref);
    return realWrite(ref);
  });
  hooks.beforeDispatch = async () => {
    hooks.beforeDispatch = undefined;
    reachedDispatch.resolve();
    await continueDispatch.promise;
  };
  const publicationId = 'first-open-publication';
  const opened = daemon.send(
    'open',
    ['com.example.app'],
    { ...UNLEASED, scriptPublicationId: publicationId },
    {
      flags: { saveScript: true },
    },
  );
  const dispatched = await Promise.race([
    reachedDispatch.promise.then(() => true),
    opened.then(() => false),
  ]);
  expect(dispatched, JSON.stringify(dispatched ? undefined : await opened)).toBe(true);
  const closed = daemon.send('close', [], UNLEASED);
  continueDispatch.resolve();

  const response = await opened;
  expect(response.result?.data?.artifacts, JSON.stringify(response)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scriptPublicationId: publicationId, scriptRevision: 1 }),
    ]),
  );
  expect((await closed).result?.ok).toBe(true);
  expect(written).toHaveLength(1);

  const replacement = await daemon.send('open', ['com.example.other'], UNLEASED);
  expect(replacement.result?.ok, JSON.stringify(replacement)).toBe(true);
  expect(sessionStore.lookup(SESSION)?.lifetime).not.toBe(written[0]?.lifetime);
});

test('delayed suite recording and cleanup leave a replacement attempt lifetime intact', async () => {
  const daemon = world;
  if (!daemon) return;
  const name = attemptAddress(SUITE_SESSION);
  const session = makeIosAppSession(name, { sessionScope: { kind: 'tenant', id: TENANT } });
  session.screenRecording = makeTestScreenRecordingResource(session, { scope: 'device' });
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(daemon.sessionStore.resolveSessionDir(name)),
    session.screenRecording.envelope,
  );
  const original = daemon.sessionStore.publish(name, session);
  const tailStarted = deferred();
  const finishTail = deferred();
  const sleep = retry.sleep;
  vi.spyOn(retry, 'sleep').mockImplementation(async (ms) => {
    if (ms !== 3_000) return await sleep(ms);
    tailStarted.resolve();
    await finishTail.promise;
  });

  const suite = writeSuite();
  const response = daemon.send(
    'test',
    suite.positionals,
    { ...UNLEASED, requestId: SUITE_REQUEST_ID },
    {
      session: SUITE_SESSION,
      flags: suite.flags,
    },
  );
  const reachedTail = await Promise.race([
    tailStarted.promise.then(() => true),
    response.then(() => false),
  ]);
  expect(reachedTail, JSON.stringify(reachedTail ? undefined : await response)).toBe(true);
  let replacement: SessionRef | undefined;
  let replacementCapture: typeof session.screenRecording;
  try {
    const closed = await daemon.send('close', [], UNLEASED, { session: name });
    expect(closed.result?.ok, JSON.stringify(closed)).toBe(true);
    const opened = await daemon.send('open', ['com.example.replacement'], UNLEASED, {
      session: name,
    });
    expect(opened.result?.ok, JSON.stringify(opened)).toBe(true);
    replacement = daemon.sessionStore.lookup(name);
    expect(replacement?.lifetime).not.toBe(original.lifetime);
    if (!replacement) throw new Error('Expected a replacement lifetime');
    replacementCapture = makeTestScreenRecordingResource(replacement.session, { scope: 'device' });
    screenRecordingResourceStore.write(
      screenRecordingResourceStore.resolvePath(daemon.sessionStore.resolveSessionDir(name)),
      replacementCapture.envelope,
    );
    daemon.sessionStore.update(replacement, { screenRecording: replacementCapture });
  } finally {
    finishTail.resolve();
    await response;
  }

  expect((await response).result?.data).toMatchObject({ passed: 1, failed: 0 });
  expect(replacement).toBeDefined();
  expect(daemon.sessionStore.lookup(name)?.lifetime).toBe(replacement?.lifetime);
  expect(daemon.sessionStore.get(name)?.screenRecording).toBe(replacementCapture);
});

test('a canceled queued attempt never acquires or cleans up the lifetime opened ahead of it', async () => {
  const daemon = world;
  if (!daemon) return;
  const name = attemptAddress(SUITE_SESSION);
  const key = `session:${name}`;
  const locks = getLeaseRegistryExecutionLocks(daemon.leaseRegistry);
  const gate = deferred();
  const occupied = deferred();
  const holder = withKeyedLock(locks, key, async () => {
    occupied.resolve();
    await gate.promise;
    return daemon.sessionStore.publish(name, makeIosAppSession(name));
  });
  await occupied.promise;
  const initialLock = locks.get(key);
  const suite = writeSuite('context platform=ios timeout=100\nwait 0\n');
  const pending = daemon.send(
    'test',
    suite.positionals,
    { ...UNLEASED, requestId: SUITE_REQUEST_ID },
    {
      session: SUITE_SESSION,
      flags: { ...suite.flags, recordVideo: false },
    },
  );
  try {
    const response = await pending;
    expect(response.result?.data).toMatchObject({ failed: 1 });
    expect(JSON.stringify(response)).not.toContain('cleanup may still');
    expect(locks.get(key)).not.toBe(initialLock);
  } finally {
    gate.resolve();
  }
  const successor = await holder;
  await locks.get(key)?.catch(() => {});
  expect(daemon.sessionStore.resolveCurrent(successor)).toBe(successor.session);
});

test('a recording on a timed-out attempt exports inside the video tail when replay settles', async () => {
  const daemon = world;
  if (!daemon) return;
  const name = attemptAddress(SUITE_SESSION);
  const session = makeIosAppSession(name);
  const outPath = path.join(mkdtempForTestSync('attempt-video-tail-'), 'capture.mp4');
  fs.writeFileSync(outPath, 'capture');
  session.screenRecording = makeTestScreenRecordingResource(session, { scope: 'device', outPath });
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(daemon.sessionStore.resolveSessionDir(name)),
    session.screenRecording.envelope,
  );
  daemon.sessionStore.publish(name, session);
  const holdingReplay = deferred();
  const settleReplay = deferred();
  daemon.hooks.beforeDispatch = () => {
    daemon.hooks.beforeDispatch = async () => {
      daemon.hooks.beforeDispatch = undefined;
      holdingReplay.resolve();
      await settleReplay.promise;
    };
  };
  let tailReached = false;
  const sleep = retry.sleep;
  vi.spyOn(retry, 'sleep').mockImplementation(async (ms) => {
    if (ms === 2_000) return;
    if (ms !== 3_000) return await sleep(ms);
    tailReached = true;
    settleReplay.resolve();
    const key = `session:${name}`;
    await getLeaseRegistryExecutionLocks(daemon.leaseRegistry)
      .get(key)
      ?.catch(() => {});
  });
  const suite = writeSuite('context platform=ios timeout=100\nopen "com.example.app"\n');
  const response = daemon.send(
    'test',
    suite.positionals,
    { ...UNLEASED, requestId: SUITE_REQUEST_ID },
    {
      session: SUITE_SESSION,
      flags: suite.flags,
    },
  );
  try {
    expect(
      await Promise.race([holdingReplay.promise.then(() => true), response.then(() => false)]),
    ).toBe(true);
    const result = await response;
    expect(tailReached).toBe(true);
    expect(JSON.stringify(result)).toContain('capture.mp4');
    expect(JSON.stringify(result)).not.toContain('timeout_cleanup_pending');
    expect(daemon.sessionStore.get(name)).toBeUndefined();
  } finally {
    settleReplay.resolve();
    await response;
  }
});
