import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  acquireDeviceClaim,
  inspectDeviceClaims,
  canonicalLocalDeviceKey,
} from '@agent-device/daemon-contracts/device-claims';
import { createRecordingReapAdmission } from '@agent-device/daemon-contracts/device-claim-recovery';
import { acquireProcessLockAcquisition, inspectProcessLock } from '@agent-device/host-kit/file';
import {
  createOwnedProcessRecordStore,
  readCurrentOwnerIdentity,
  readProcessIdentityFacts,
  reapOwnedProcessRecordsAtStartup,
} from '@agent-device/host-kit/process';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';

const control = vi.hoisted(() => ({
  liveness: 'live' as 'live' | 'unknown' | 'owner-process-dead' | 'owner-process-reused',
  ownerPid: 0,
  lockPath: '',
  beforeAttempt: undefined as (() => void) | undefined,
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    classifyOwnerLiveness: (input: Parameters<typeof actual.classifyOwnerLiveness>[0]) =>
      input.owner.pid === control.ownerPid ? control.liveness : actual.classifyOwnerLiveness(input),
  };
});

vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return {
    ...actual,
    tryAcquireProcessLock: (input: Parameters<typeof actual.tryAcquireProcessLock>[0]) => {
      if (input.lockDirPath === control.lockPath) control.beforeAttempt?.();
      return actual.tryAcquireProcessLock(input);
    },
  };
});

import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

const device = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'simulator-1',
  name: 'Simulator',
  kind: 'simulator',
} as const;
const identity = { family: 'apple', appleOs: 'ios', id: device.id, kind: 'simulator' } as const;
const fence = { token: 'fence-a', generation: 4 };
const session = 'recording';

afterEach(() => {
  control.ownerPid = 0;
  control.liveness = 'live';
  control.lockPath = '';
  control.beforeAttempt = undefined;
});

async function fixture() {
  const root = mkdtempForTestSync('daemon-recording-reaper-');
  const stateDir = path.join(root, 'state');
  const sessionsDir = path.join(stateDir, 'sessions');
  const sessionDir = path.join(sessionsDir, session);
  const env = {
    ...process.env,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
    AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
  };
  const signalPath = path.join(root, 'signal');
  const nativePath = path.join(root, 'native.mp4');
  const markerPath = path.join(root, 'marker');
  fs.writeFileSync(nativePath, 'recoverable video');
  fs.writeFileSync(markerPath, 'stop checkpoint');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    process.on('SIGINT', () => { fs.writeFileSync(process.argv[1], 'SIGINT'); process.send('signalled'); });
    process.on('message', message => { if (message === 'exit') process.exit(0); });
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
      signalPath,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', () => resolve());
    });
    const oldDaemon = spawn(
      process.execPath,
      ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        oldDaemon.once('error', reject);
        oldDaemon.once('message', () => resolve());
      });
      const oldIdentity = await readProcessIdentityFacts(oldDaemon.pid!);
      if (!oldIdentity.startTime) throw new Error('old daemon identity unavailable');
      const pid = child.pid!;
      const facts = await readProcessIdentityFacts(pid);
      if (!facts.startTime || !facts.command) throw new Error('test child identity unavailable');
      const processRecord = {
        pid,
        startTime: facts.startTime,
        command: facts.command,
        purpose: 'simctl-screen-recording',
      };
      const store = createOwnedProcessRecordStore({
        stateDir,
        sessionsDir,
        resolveSessionDir: (id) => path.join(sessionsDir, id),
      });
      store.replace({ kind: 'session', sessionId: session }, [processRecord]);
      const acquired = await acquireDeviceClaim({
        device,
        session,
        workspace: root,
        stateDir,
        env,
        reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
      });
      if (acquired.status !== 'acquired') throw new Error('test claim not acquired');
      const claimEntry = inspectDeviceClaims({}, env)[0]!;
      const claimPath = path.join(env.AGENT_DEVICE_CLAIMS_DIR, claimEntry.fileName);
      const claim = {
        ...claimEntry.claim!,
        ownerPid: oldDaemon.pid!,
        ownerStartTime: oldIdentity.startTime,
        claimOwnerKind: 'transient-command' as const,
        transientCommand: 'record',
        recordingFence: fence,
      };
      fs.writeFileSync(claimPath, JSON.stringify(claim));
      const resourcePath = screenRecordingResourceStore.resolvePath(sessionDir);
      const envelope = createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: session,
        device: identity,
        owner: localRuntimeOwner('apple'),
        fence,
        lifecycle: 'open',
        descriptor: {
          version: 1,
          body: { backend: 'simctl', outputPath: nativePath, processes: [processRecord] },
        },
        metadata: { deviceClaimToken: claim.ownerToken, stopCheckpoint: 'preserve' },
      });
      screenRecordingResourceStore.write(resourcePath, envelope);
      control.ownerPid = claim.ownerPid;
      let httpPort: number | undefined;
      const start = async () =>
        await startDaemonRuntime({
          composeDeps: daemonRuntimeDepsFixture(),
          host: createTestHostEnvironment({ env }),
          stderr: { write: () => {} },
          stdout: {
            write: (text) => {
              const match = /AGENT_DEVICE_DAEMON_HTTP_PORT=(\d+)/.exec(text);
              if (match) httpPort = Number(match[1]);
            },
          },
        });
      const cleanup = async () => {
        await stopChild(child);
        await stopChild(oldDaemon);
        fs.rmSync(root, { recursive: true, force: true });
      };
      return {
        root,
        env,
        stateDir,
        sessionsDir,
        child,
        oldDaemon,
        claim,
        claimPath,
        resourcePath,
        envelope,
        nativePath,
        markerPath,
        signalPath,
        store,
        start,
        cleanup,
        getHttpPort: () => httpPort,
      };
    } catch (error) {
      await stopChild(oldDaemon);
      throw error;
    }
  } catch (error) {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

function expectPreserved(f: Awaited<ReturnType<typeof fixture>>) {
  expect(fs.existsSync(f.signalPath)).toBe(false);
  expect(fs.readFileSync(f.nativePath, 'utf8')).toBe('recoverable video');
  expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('stop checkpoint');
  expect(screenRecordingResourceStore.read(f.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { stopCheckpoint: 'preserve' } },
  });
  expect(fs.existsSync(f.claimPath)).toBe(true);
  expect(f.store.read()[0]?.records).toHaveLength(1);
}

test.each(['live', 'unknown'] as const)(
  'startup retains the recorder of an %s old owner',
  async (liveness) => {
    const f = await fixture();
    let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
    let startup: ReturnType<typeof f.start> | undefined;
    try {
      control.liveness = liveness;
      const signalled = new Promise<'signalled'>((resolve) => {
        f.child.on('message', (message) => {
          if (message === 'signalled') resolve('signalled');
        });
      });
      startup = f.start();
      const result = await Promise.race([
        startup.then((value) => ({ kind: 'started' as const, value })),
        signalled.then(() => ({ kind: 'signalled' as const })),
      ]);
      expect(result.kind).toBe('started');
      if (result.kind !== 'started') return;
      runtime = result.value;
      expect(runtime).not.toBeNull();
      expectPreserved(f);
      if (liveness === 'live')
        expect(inspectDeviceClaims({}, f.env)[0]?.classification).toBe('owner-daemon-superseded');
    } finally {
      await stopChild(f.child);
      if (!runtime && startup) runtime = await startup.catch(() => undefined);
      await runtime?.close();
      await f.cleanup();
    }
  },
);

test.each(['token', 'fence', 'device', 'identity', 'stateDir', 'session'] as const)(
  'startup retains a recording with replaced %s',
  async (replacement) => {
    const f = await fixture();
    let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
    try {
      await stopChild(f.oldDaemon);
      control.ownerPid = 0;
      if (replacement === 'token')
        fs.writeFileSync(f.claimPath, JSON.stringify({ ...f.claim, ownerToken: 'successor' }));
      if (replacement === 'fence')
        fs.writeFileSync(
          f.claimPath,
          JSON.stringify({ ...f.claim, recordingFence: { ...fence, generation: 5 } }),
        );
      if (replacement === 'stateDir')
        fs.writeFileSync(
          f.claimPath,
          JSON.stringify({ ...f.claim, stateDir: path.join(f.root, 'foreign') }),
        );
      if (replacement === 'session')
        fs.writeFileSync(f.claimPath, JSON.stringify({ ...f.claim, session: 'foreign' }));
      if (replacement === 'device')
        screenRecordingResourceStore.write(f.resourcePath, {
          ...f.envelope,
          device: { ...identity, id: 'other' },
        });
      if (replacement === 'identity')
        screenRecordingResourceStore.write(f.resourcePath, {
          ...f.envelope,
          descriptor: {
            version: 1,
            body: {
              ...f.envelope.descriptor.body,
              processes: [{ pid: f.child.pid!, startTime: 'foreign', command: 'foreign' }],
            },
          },
        });
      const claimBefore = fs.readFileSync(f.claimPath, 'utf8');
      runtime = await f.start();
      expectPreserved(f);
      expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(claimBefore);
    } finally {
      await runtime?.close();
      await f.cleanup();
    }
  },
);

test('busy claim retains the recorder and the listening daemon can later reap the dead owner', async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  let held: Awaited<ReturnType<typeof acquireProcessLockAcquisition>> | undefined;
  let startup: ReturnType<typeof f.start> | undefined;
  try {
    const owner = readCurrentOwnerIdentity();
    const lockPath = `${f.claimPath}.lock`;
    held = await acquireProcessLockAcquisition({
      lockDirPath: lockPath,
      owner: { ...owner, acquiredAtMs: Date.now() },
      timeoutMs: 1_000,
    });
    const began = performance.now();
    startup = f.start();
    await vi.waitFor(() => expect(f.getHttpPort()).toBeDefined());
    const elapsed = performance.now() - began;
    expect(elapsed).toBeLessThan(3_000);
    const response = await fetch(`http://127.0.0.1:${f.getHttpPort()}/health`);
    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(fs.readFileSync(path.join(f.stateDir, 'daemon.log'), 'utf8')).toContain(
        'claim-lock-busy',
      ),
    );
    expectPreserved(f);
    expect(inspectProcessLock(lockPath).state).toBe('held');
    await held.release();
    held = undefined;
    runtime = await startup;
    expectPreserved(f);
    await runtime.close();
    runtime = undefined;

    await stopChild(f.oldDaemon);
    control.ownerPid = 0;
    startup = f.start();
    await vi.waitFor(() => expect(fs.readFileSync(f.signalPath, 'utf8')).toBe('SIGINT'));
    expect(inspectProcessLock(lockPath).state).toBe('held');
    expect(f.child.exitCode).toBeNull();
    f.child.send!('exit');
    runtime = await startup;
    expect(fs.readFileSync(f.nativePath, 'utf8')).toBe('recoverable video');
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('stop checkpoint');
    expect(screenRecordingResourceStore.read(f.resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open', metadata: { stopCheckpoint: 'preserve' } },
    });
    expect(fs.existsSync(f.claimPath)).toBe(true);
    expect(f.store.read()).toEqual([]);
  } finally {
    await held?.release();
    await stopChild(f.child);
    if (!runtime && startup) runtime = await startup.catch(() => undefined);
    await runtime?.close();
    await f.cleanup();
  }
});

test('one admission budget retains later records and leaves no lock waiter after return', async () => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof acquireProcessLockAcquisition>> | undefined;
  let now = 10;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const original = f.store.read()[0]!.records[0]!;
    for (let i = 1; i <= 12; i++) {
      const name = `recording-${i}`;
      const nextDevice = { ...identity, id: `simulator-${i + 1}` };
      const deviceKey = canonicalLocalDeviceKey(nextDevice);
      const claimPath = path.join(
        f.env.AGENT_DEVICE_CLAIMS_DIR,
        `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
      );
      fs.writeFileSync(
        claimPath,
        JSON.stringify({
          ...f.claim,
          deviceKey,
          device: { ...nextDevice, name: 'Simulator' },
          session: name,
        }),
      );
      screenRecordingResourceStore.write(
        screenRecordingResourceStore.resolvePath(path.join(f.sessionsDir, name)),
        { ...f.envelope, sessionId: name, device: nextDevice },
      );
      f.store.replace({ kind: 'session', sessionId: name }, [original]);
    }
    const owner = readCurrentOwnerIdentity();
    held = await acquireProcessLockAcquisition({
      lockDirPath: `${f.claimPath}.lock`,
      owner: { ...owner, acquiredAtMs: Date.now() },
      timeoutMs: 1_000,
    });
    const retained: string[] = [];
    let callbacks = 0;
    const admission = createRecordingReapAdmission({
      stateDir: f.stateDir,
      sessionsDir: f.sessionsDir,
      env: f.env,
      onRetained: ({ reason }) => {
        retained.push(reason);
        now = 2_000;
      },
    });
    const summary = await reapOwnedProcessRecordsAtStartup(f.store, {
      purposes: ['simctl-screen-recording'],
      withRecordingAdmission: async (scope, record, reap) =>
        await admission(scope, record, async () => {
          callbacks++;
          await reap();
        }),
    });
    expect(retained).toEqual(['claim-lock-busy', ...Array(12).fill('admission-budget-exhausted')]);
    expect(summary.inspected).toBe(0);
    expect(callbacks).toBe(0);
    expect(f.store.read()).toHaveLength(13);
    expectPreserved(f);
    await held.release();
    held = undefined;
    await Promise.resolve();
    expect(callbacks).toBe(0);
    expect(fs.existsSync(f.signalPath)).toBe(false);
  } finally {
    clock.mockRestore();
    await held?.release();
    await f.cleanup();
  }
});

test('an uninspectable claim lock is retained with a typed diagnostic', async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    const owner = readCurrentOwnerIdentity();
    fs.writeFileSync(
      f.claimPath,
      JSON.stringify({ ...f.claim, ownerPid: owner.pid, ownerStartTime: owner.startTime }),
    );
    control.ownerPid = owner.pid;
    fs.mkdirSync(`${f.claimPath}.lock`);
    runtime = await f.start();
    expect((await fetch(`http://127.0.0.1:${runtime.httpPort}/health`)).status).toBe(200);
    expect(fs.readFileSync(path.join(f.stateDir, 'daemon.log'), 'utf8')).toContain(
      'claim-lock-unproven',
    );
    expectPreserved(f);
    expect(inspectProcessLock(`${f.claimPath}.lock`)).toMatchObject({
      state: 'unproven',
      reason: 'owner-unwritten',
    });
  } finally {
    await runtime?.close();
    await f.cleanup();
  }
});

test('a successor claim published immediately before lock acquisition is retained', async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    await stopChild(f.oldDaemon);
    control.ownerPid = 0;
    const replacement = { ...f.claim, ownerToken: 'successor' };
    control.lockPath = `${f.claimPath}.lock`;
    control.beforeAttempt = () => {
      control.beforeAttempt = undefined;
      fs.writeFileSync(f.claimPath, JSON.stringify(replacement));
    };
    runtime = await f.start();
    expectPreserved(f);
    expect(JSON.parse(fs.readFileSync(f.claimPath, 'utf8'))).toEqual(replacement);
  } finally {
    await runtime?.close();
    await f.cleanup();
  }
});

test('unexpected lock acquisition failures propagate and preserve the recording', async () => {
  const f = await fixture();
  try {
    control.lockPath = `${f.claimPath}.lock`;
    control.beforeAttempt = () => {
      throw new Error('unexpected lock failure');
    };
    await expect(f.start()).rejects.toThrow('unexpected lock failure');
    expectPreserved(f);
    expect(inspectProcessLock(control.lockPath).state).toBe('absent');
  } finally {
    await f.cleanup();
  }
});

test('full daemon startup and authenticated RPC complete while the orphan claim lock is busy', async () => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof acquireProcessLockAcquisition>> | undefined;
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  let recovery: Promise<unknown> | undefined;
  let startup: ReturnType<typeof f.start> | undefined;
  try {
    await stopChild(f.oldDaemon);
    control.ownerPid = 0;
    const owner = readCurrentOwnerIdentity();
    held = await acquireProcessLockAcquisition({
      lockDirPath: `${f.claimPath}.lock`,
      owner: { ...owner, acquiredAtMs: Date.now() },
      timeoutMs: 1_000,
    });
    const starting = f.start();
    startup = starting;
    runtime = await Promise.race([
      starting,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('full daemon startup waited on a busy claim')),
          3_000,
        );
        timer.unref();
        void starting.finally(() => clearTimeout(timer)).catch(() => {});
      }),
    ]);
    const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ready',
        method: 'agent_device.command',
        params: { command: 'session_list', meta: { requestId: 'ready' } },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'ready', result: expect.anything() });
    expectPreserved(f);
    expect(fs.readFileSync(path.join(f.stateDir, 'daemon.log'), 'utf8')).toContain(
      'device_claim_reconcile_retained',
    );
    await held.release();
    held = undefined;
    await Promise.resolve();
    expectPreserved(f);
    const admission = createRecordingReapAdmission({
      stateDir: f.stateDir,
      sessionsDir: f.sessionsDir,
      env: f.env,
      onRetained: () => {},
    });
    recovery = reapOwnedProcessRecordsAtStartup(f.store, {
      purposes: ['simctl-screen-recording'],
      withRecordingAdmission: admission,
    });
    await vi.waitFor(() => expect(fs.readFileSync(f.signalPath, 'utf8')).toBe('SIGINT'));
    expect(inspectProcessLock(`${f.claimPath}.lock`).state).toBe('held');
    f.child.send!('exit');
    await recovery;
    expect(f.store.read()).toEqual([]);
    expect(fs.readFileSync(f.nativePath, 'utf8')).toBe('recoverable video');
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('stop checkpoint');
    expect(fs.existsSync(f.claimPath)).toBe(true);
  } finally {
    await held?.release();
    await stopChild(f.child);
    await recovery?.catch(() => {});
    if (!runtime && startup) runtime = await startup.catch(() => undefined);
    await runtime?.close();
    await f.cleanup();
  }
});

test('startup retains an unproven orphan lock while reconciling a separate claim', async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    await stopChild(f.oldDaemon);
    control.ownerPid = 0;
    const otherDevice = { ...identity, id: 'other-simulator' };
    const otherKey = canonicalLocalDeviceKey(otherDevice);
    const otherPath = path.join(
      f.env.AGENT_DEVICE_CLAIMS_DIR,
      `${crypto.createHash('sha256').update(otherKey).digest('hex')}.json`,
    );
    const { transientCommand: _command, recordingFence: _fence, ...claim } = f.claim;
    fs.writeFileSync(
      otherPath,
      JSON.stringify({
        ...claim,
        deviceKey: otherKey,
        device: { ...otherDevice, name: 'Other Simulator' },
        session: 'other-session',
        claimOwnerKind: 'open-session',
      }),
    );
    fs.mkdirSync(`${f.claimPath}.lock`);
    runtime = await f.start();
    expectPreserved(f);
    expect(fs.existsSync(otherPath)).toBe(false);
    const log = fs.readFileSync(path.join(f.stateDir, 'daemon.log'), 'utf8');
    expect(log).toContain('device_claim_reconcile_retained');
    expect(log).toContain('claim-lock-unproven');
    expect(inspectProcessLock(`${f.claimPath}.lock`).state).toBe('unproven');
  } finally {
    await runtime?.close();
    await f.cleanup();
  }
});
