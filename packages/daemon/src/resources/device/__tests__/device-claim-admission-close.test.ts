import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import {
  inspectDeviceClaims,
  reconcileOrphanedDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { createOwnerScopedDeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claim-recovery';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { handleSessionCloseCommands } from '../../../sessions/session-lifecycle/internal/session-close.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { isolatedDeviceClaimStores } from '../../../__tests__/support/device-claim-store.ts';
import { fixture as createFixture } from './device-claim-admission-ownership.fixtures.ts';

const setup = isolatedDeviceClaimStores('recording-close-obligation-');
const fixture = () => createFixture(setup);

function runClose(
  f: ReturnType<typeof fixture>,
  close: Awaited<ReturnType<ReturnType<typeof fixture>['scopeFor']>>,
) {
  return close.runLocked(
    async () =>
      await handleSessionCloseCommands({
        host: f.host,
        req: close.req,
        sessionName: close.sessionName,
        logPath: close.requestLogPath,
        sessionStore: f.store,
        leaseRegistry: f.registry,
        inspectFacts: close.inspectFacts,
        bindDevice: close.bindDevice,
        platformServices: close.platformServices,
        platformResourceCleanup: platformResourceCleanupFixture(),
      }),
  );
}

test.each([false, true])(
  'failed app teardown retains the session and claim when binding disposal fails: %s',
  async (bindingFails) => {
    const f = fixture();
    const child = spawn(
      process.execPath,
      ['-e', String.raw`process.stdout.write('ready\n'); process.stdin.resume()`],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    let retryClose: Awaited<ReturnType<typeof f.scopeFor>> | undefined;
    try {
      await once(child.stdout, 'data');
      const ref = f.publish(true);
      expect((await f.record('start', f.workspace)).ok).toBe(true);
      f.store.update(ref, { appBundleId: 'org.example.editor' });
      expect((await f.record('stop', f.workspace)).ok).toBe(true);
      const original = inspectDeviceClaims({}, f.host.env)[0]!.claim!;
      f.closeApplication.mockRejectedValueOnce(new Error('owned app did not close'));
      let releaseRetry!: () => void;
      let retryEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        retryEntered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      if (bindingFails) {
        f.setBindingDisposal(async () => {
          throw new Error('binding did not dispose');
        });
        f.setBindingRetry(async () => {
          retryEntered();
          await gate;
        });
      }
      const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
      await expect(runClose(f, close)).rejects.toThrow('owned app did not close');
      if (bindingFails)
        await expect(Promise.resolve(close[Symbol.asyncDispose]())).rejects.toThrow(
          'binding did not dispose',
        );
      else await close[Symbol.asyncDispose]();
      expect(f.store.lookup('recording')).toBeDefined();
      expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
        ownerToken: original.ownerToken,
        recordingCleanupPending: true,
        recordingClosePending: true,
      });
      expect(child.exitCode).toBeNull();
      const other = new SessionStore(path.join(f.root, 'other-state', 'sessions'), f.host);
      other.publish('recording', {
        name: 'recording',
        device: f.device,
        createdAt: 1,
        actions: [],
        recordOnlySession: true,
      });
      f.start.mockClear();
      expect(await f.record('start', f.workspace, other, new LeaseRegistry())).toMatchObject({
        ok: false,
        error: { code: 'DEVICE_IN_USE' },
      });
      expect(f.start).not.toHaveBeenCalled();
      if (bindingFails)
        f.closeApplication.mockRejectedValueOnce(new Error('owned app still did not close'));
      else
        f.closeApplication.mockImplementationOnce(async () => {
          child.stdin.end();
          await exited;
        });
      retryClose = await f.scopeFor('close', 'org.example.editor', f.workspace);
      const retry = runClose(f, retryClose);
      if (bindingFails) {
        await entered;
        expect(f.closeApplication).toHaveBeenCalledTimes(1);
        expect(inspectDeviceClaims({}, f.host.env)[0]?.claim?.ownerToken).toBe(original.ownerToken);
        expect(child.exitCode).toBeNull();
        releaseRetry();
      }
      if (bindingFails) {
        await expect(retry).rejects.toThrow('owned app still did not close');
        expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
          ownerToken: original.ownerToken,
          recordingCleanupPending: true,
          recordingClosePending: true,
        });
        expect(child.exitCode).toBeNull();
        f.closeApplication.mockImplementationOnce(async () => {
          child.stdin.end();
          await exited;
        });
        const finalClose = await f.scopeFor('close', 'org.example.editor', f.workspace);
        expect((await runClose(f, finalClose)).ok).toBe(true);
        await finalClose[Symbol.asyncDispose]();
      } else expect((await retry).ok).toBe(true);
      await retryClose[Symbol.asyncDispose]();
      expect(child.exitCode).toBe(0);
      expect(inspectDeviceClaims({}, f.host.env)).toHaveLength(0);
      expect(f.store.lookup('recording')).toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      if (retryClose) await Promise.resolve(retryClose[Symbol.asyncDispose]()).catch(() => {});
    }
  },
);

test('the real stale sweep retains a close obligation when its recorded owner has exited', async () => {
  const f = fixture();
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  f.store.update(ref, { appBundleId: 'org.example.editor' });
  expect((await f.record('stop', f.workspace)).ok).toBe(true);
  f.closeApplication.mockRejectedValueOnce(new Error('owned app did not close'));
  const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
  await expect(runClose(f, close)).rejects.toThrow('owned app did not close');
  await close[Symbol.asyncDispose]();
  const claimPath = path.join(
    f.claimsDir,
    fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
  );
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(child, 'exit');
  fs.writeFileSync(
    claimPath,
    JSON.stringify({ ...claim, ownerPid: child.pid, ownerStartTime: null }),
  );
  const before = fs.readFileSync(claimPath, 'utf8');
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope: f.scope,
    composeGateway: () => f.gateway,
  });
  expect((await reconcileOrphanedDeviceClaims(reconcile, f.stateDir, f.host.env)).retained).toBe(1);
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
});

test('a changed session owner cannot be cleared by an old binding cleanup retry', async () => {
  const f = fixture();
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  f.store.update(ref, { appBundleId: 'org.example.editor' });
  expect((await f.record('stop', f.workspace)).ok).toBe(true);
  let releaseRetry!: () => void;
  let retryEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    retryEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  f.setBindingDisposal(async () => {
    throw new Error('binding did not dispose');
  });
  f.setBindingRetry(async () => {
    retryEntered();
    await gate;
  });
  const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
  expect((await runClose(f, close)).ok).toBe(true);
  await expect(Promise.resolve(close[Symbol.asyncDispose]())).rejects.toThrow(
    'binding did not dispose',
  );
  const claimPath = path.join(
    f.claimsDir,
    fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
  );
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  const retryClose = await f.scopeFor('close', undefined, f.workspace);
  const retry = runClose(f, retryClose);
  try {
    await entered;
    const replacement = { pid: 1, startTime: 'different-owner' };
    fs.writeFileSync(claimPath, JSON.stringify({ ...claim, recordingSessionOwner: replacement }));
    releaseRetry();
    await expect(retry).rejects.toMatchObject({ code: 'DEVICE_IN_USE' });
    expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toMatchObject({
      ownerToken: claim.ownerToken,
      recordingCleanupPending: true,
      recordingSessionOwner: replacement,
    });
  } finally {
    releaseRetry();
    await retry.catch(() => {});
    await Promise.resolve(retryClose[Symbol.asyncDispose]()).catch(() => {});
  }
});

test('closing a live record-only session keeps its reservation through failed app teardown', async () => {
  const f = fixture();
  const ref = f.publish(true);
  f.store.update(ref, { appBundleId: 'org.example.editor' });
  const start = f.start.getMockImplementation()!;
  f.start.mockImplementationOnce(async (input) => {
    expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
      recordingSessionOwner: { pid: process.pid, startTime: expect.any(String) },
      recordingCleanupPending: true,
    });
    return await start(input);
  });
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  const original = inspectDeviceClaims({}, f.host.env)[0]!.claim!;
  f.closeApplication.mockRejectedValueOnce(new Error('app close failed'));
  const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
  await expect(runClose(f, close)).rejects.toThrow('app close failed');
  await close[Symbol.asyncDispose]();
  expect(f.store.lookup('recording')).toBeDefined();
  expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
    ownerToken: original.ownerToken,
    recordingSessionOwner: original.recordingSessionOwner,
    recordingCleanupPending: true,
    recordingClosePending: true,
  });
  const retry = await f.scopeFor('close', 'org.example.editor', f.workspace);
  expect((await runClose(f, retry)).ok).toBe(true);
  await retry[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({}, f.host.env)).toHaveLength(0);
});
