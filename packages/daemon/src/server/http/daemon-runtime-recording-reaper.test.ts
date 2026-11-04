import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  acquireDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { acquireProcessLockAcquisition, inspectProcessLock } from '@agent-device/host-kit/file';
import {
  createOwnedProcessRecordStore,
  readCurrentOwnerIdentity,
  readProcessIdentityFacts,
} from '@agent-device/host-kit/process';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';

const control = vi.hoisted(() => ({
  liveness: 'live' as 'live' | 'unknown' | 'owner-process-dead' | 'owner-process-reused',
  ownerPid: 0,
  lockPath: '',
  attempted: undefined as (() => void) | undefined,
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
    acquireProcessLockAcquisition: async (
      input: Parameters<typeof actual.acquireProcessLockAcquisition>[0],
    ) => {
      if (input.lockDirPath === control.lockPath) control.attempted?.();
      return await actual.acquireProcessLockAcquisition(input);
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
  control.attempted = undefined;
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
      const start = async () =>
        await startDaemonRuntime({
          composeDeps: daemonRuntimeDepsFixture(),
          host: createTestHostEnvironment({ env }),
          stderr: { write: () => {} },
          stdout: { write: () => {} },
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

test('startup holds the claim through recorder exit and preserves its export material', async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  let held: Awaited<ReturnType<typeof acquireProcessLockAcquisition>> | undefined;
  let startup: ReturnType<typeof f.start> | undefined;
  try {
    await stopChild(f.oldDaemon);
    control.ownerPid = 0;
    const owner = readCurrentOwnerIdentity();
    const lockPath = `${f.claimPath}.lock`;
    held = await acquireProcessLockAcquisition({
      lockDirPath: lockPath,
      owner: { ...owner, acquiredAtMs: Date.now() },
      timeoutMs: 1_000,
    });
    const attempted = new Promise<void>((resolve) => {
      control.lockPath = lockPath;
      control.attempted = resolve;
    });
    startup = f.start();
    await attempted;
    expectPreserved(f);
    await held.release();
    held = undefined;
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

test('a replacement claim published while startup waits is never signalled or cleared', async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
  let held: Awaited<ReturnType<typeof acquireProcessLockAcquisition>> | undefined;
  let startup: ReturnType<typeof f.start> | undefined;
  try {
    await stopChild(f.oldDaemon);
    control.ownerPid = 0;
    const owner = readCurrentOwnerIdentity();
    const lockPath = `${f.claimPath}.lock`;
    held = await acquireProcessLockAcquisition({
      lockDirPath: lockPath,
      owner: { ...owner, acquiredAtMs: Date.now() },
      timeoutMs: 1_000,
    });
    const attempted = new Promise<void>((resolve) => {
      control.lockPath = lockPath;
      control.attempted = resolve;
    });
    startup = f.start();
    await attempted;
    const replacement = { ...f.claim, ownerToken: 'successor' };
    fs.writeFileSync(f.claimPath, JSON.stringify(replacement));
    await held.release();
    held = undefined;
    runtime = await startup;
    expectPreserved(f);
    expect(JSON.parse(fs.readFileSync(f.claimPath, 'utf8'))).toEqual(replacement);
  } finally {
    await held?.release();
    await stopChild(f.child);
    if (!runtime && startup) runtime = await startup.catch(() => undefined);
    await runtime?.close();
    await f.cleanup();
  }
});
