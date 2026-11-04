import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { handleSessionCloseCommands } from '../../../sessions/session-lifecycle/internal/session-close.ts';
import { handleRecordCommand } from '../../../sessions/handlers/record-runtime.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { isolatedDeviceClaimStores } from '../../../__tests__/support/device-claim-store.ts';
import { fixture as createFixture } from './device-claim-admission-ownership.fixtures.ts';

const setup = isolatedDeviceClaimStores('pending-recording-completion-');

test.each([
  [false, false],
  [true, false],
  [false, true],
])(
  'a usable live export keeps its claim until native cleanup settles (other owner: %s, binding failure: %s)',
  async (otherOwner, bindingFails) => {
    const f = createFixture(setup);
    const ref = f.publish(true);
    if (otherOwner) f.store.update(ref, { appBundleId: 'org.example.editor' });
    const output = path.join(f.stateDir, 'pending.mp4');
    let releaseConfirmed = false;
    const finish = vi.fn(async () => {
      fs.writeFileSync(output, 'exported video');
      return {
        status: 'completed' as const,
        result: {
          backend: 'fixture',
          outPath: output,
          startedAt: 1,
          completedAt: 2,
          scope: 'device' as const,
          showTouches: false,
          recordOnlySession: true,
        },
        cleanupPending: {
          status: 'cleanup-pending' as const,
          reason: 'cleanup-unconfirmed' as const,
        },
      };
    });
    const cleanup = vi.fn(async () =>
      releaseConfirmed
        ? ({ status: 'cleaned' } as const)
        : ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' } as const),
    );
    const handle = createScreenRecordingLiveHandle(
      {
        backend: 'fixture',
        outPath: output,
        startedAt: 1,
        scope: 'device',
        showTouches: false,
        recordOnlySession: true,
        gestureEvents: [],
      },
      { finish, forceCleanup: cleanup },
    );
    f.start.mockImplementationOnce(async (input) => ({
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: input.sessionId,
        device: deviceIdentity(f.device),
        owner: localRuntimeOwner('android'),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: {} },
      }),
    }));
    expect((await f.record('start', f.workspace)).ok).toBe(true);
    const retryBinding = vi.fn(async () => {});
    if (bindingFails) {
      f.setBindingDisposal(async () => {
        throw new Error('binding disposal failed');
      });
      f.setBindingRetry(retryBinding);
    }
    const stop = await f.scopeFor('record', 'stop', f.workspace);
    const first = await stop.runLocked(
      async () =>
        await handleRecordCommand({
          req: stop.req,
          sessionName: stop.sessionName,
          sessionStore: f.store,
          bindDevice: stop.bindDevice,
          bindExactDevice: stop.bindExactDevice,
          admissionLedger: createScreenRecordingAdmissionLedger(),
          requestScope: f.scope,
          platformServices: stop.platformServices,
          retainDeviceExecutionLock: stop.retainDeviceExecutionLock,
          throwIfCanceled: stop.throwIfCanceled,
        }),
    );
    if (bindingFails)
      await expect(Promise.resolve(stop[Symbol.asyncDispose]())).rejects.toThrow(
        'binding disposal failed',
      );
    else await stop[Symbol.asyncDispose]();
    expect(first).toMatchObject({ ok: true, data: { outPath: output } });
    expect(fs.readFileSync(output, 'utf8')).toBe('exported video');
    const claim = inspectDeviceClaims({}, f.host.env)[0]!.claim!;
    expect(claim).toMatchObject({ recordingCleanupPending: true });
    expect(f.store.lookup('recording')?.session.screenRecording).toBeDefined();
    expect(screenRecordingDurableResource.store.read(f.manifestPath)).toMatchObject({
      status: 'decoded',
      envelope: {
        lifecycle: 'open',
        metadata: { phase: 'cleanup-pending', cleanupStatus: 'cleanup-pending' },
      },
    });
    const other = new SessionStore(path.join(f.root, 'other-state', 'sessions'), f.host);
    other.publish('recording', {
      name: 'recording',
      device: f.device,
      createdAt: 1,
      actions: [],
      recordOnlySession: true,
    });
    expect(await f.record('start', f.workspace, other, new LeaseRegistry())).toMatchObject({
      ok: false,
      error: { code: 'DEVICE_IN_USE' },
    });
    fs.unlinkSync(output);
    expect((await f.record('stop', f.workspace)).ok).toBe(false);
    expect(inspectDeviceClaims({}, f.host.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    fs.writeFileSync(output, 'exported video');
    const replay = await f.record('stop', f.workspace);
    expect(replay).toMatchObject({ ok: true, data: { outPath: output } });
    expect(finish).toHaveBeenCalledOnce();
    expect(retryBinding).toHaveBeenCalledTimes(bindingFails ? 1 : 0);
    expect(inspectDeviceClaims({}, f.host.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    releaseConfirmed = true;
    expect(await f.record('stop', f.workspace)).toMatchObject({
      ok: true,
      data: { outPath: output },
    });
    expect(finish).toHaveBeenCalledOnce();
    expect(retryBinding).toHaveBeenCalledTimes(bindingFails ? 1 : 0);
    expect(screenRecordingDurableResource.store.read(f.manifestPath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed' },
    });
    expect(fs.readFileSync(output, 'utf8')).toBe('exported video');
    if (!otherOwner) expect(inspectDeviceClaims({}, f.host.env)).toHaveLength(0);
    else {
      expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
        ownerToken: claim.ownerToken,
        claimOwnerKind: 'open-session',
        recordingSessionOwner: { pid: process.pid },
      });
      const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
      expect(
        (
          await close.runLocked(
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
          )
        ).ok,
      ).toBe(true);
      await close[Symbol.asyncDispose]();
      expect(inspectDeviceClaims({}, f.host.env)).toHaveLength(0);
    }
  },
);
