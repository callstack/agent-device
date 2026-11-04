import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createAudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import { audioProbeResourceStore } from '@agent-device/capture-kit/audio-probe-resource-store';
import { encodeHostAudioProbeDescriptor } from '@agent-device/capture-kit/audio-probe-descriptor-fixtures';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  AudioProbeLiveHandle,
  AudioProbeStartInput,
} from '@agent-device/contracts/audio-probe-runtime';
import type { AudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import {
  abandonDeviceClaim,
  acquireDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { createOwnerScopedDeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claim-recovery';
import { handleAudioCommand } from '../../../sessions/session-observability/internal/session-audio.ts';
import { handleAppEventCommand } from '../../../execution/handlers/session-selector-dispatch.ts';
import { handleSessionCloseCommands } from '../../../sessions/session-lifecycle/internal/session-close.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { isolatedDeviceClaimStores } from '../../../__tests__/support/device-claim-store.ts';
import { fixture as createFixture } from './device-claim-admission-ownership.fixtures.ts';
import { retainSessionOwnerForRecording } from '../recording-session-owner.ts';

const setup = isolatedDeviceClaimStores('recording-audio-owner-');

test('audio start records the recording session obligation before its capture effect', async () => {
  const f = createFixture(setup);
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  const original = inspectDeviceClaims({}, f.host.env)[0]!.claim!;
  expect(original.recordingSessionOwner).toBeUndefined();
  const status: AudioProbeResult = {
    audio: 'probe',
    state: 'running',
    active: true,
    heard: false,
    source: 'system-audio',
    backend: 'fixture-audio',
    durationMs: 1000,
    elapsedMs: 0,
    bucketMs: 500,
    sampleCount: 0,
    sourceCount: 1,
    rmsDbfs: [],
    peakDbfs: [],
  };
  const handle: AudioProbeLiveHandle = {
    inspect: () => ({
      source: 'system-audio',
      backend: 'fixture-audio',
      sourceCount: 1,
      notes: [],
      statusPath: path.join(f.stateDir, 'status'),
      startedAt: 1,
      durationMs: 1000,
      bucketMs: 500,
    }),
    status: async () => status,
    finish: async () => ({
      status: 'completed',
      result: { ...status, state: 'stopped', active: false },
    }),
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
  const start = async (input: AudioProbeStartInput) => {
    expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
      ownerToken: original.ownerToken,
      recordingSessionOwner: { pid: process.pid, startTime: expect.any(String) },
    });
    fs.writeFileSync(input.statusPath, 'audio effect');
    return {
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'audio-probe',
        sessionId: input.sessionId,
        device: deviceIdentity(f.device),
        owner: localRuntimeOwner('android'),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: encodeHostAudioProbeDescriptor({
          backend: 'macos-screencapturekit',
          source: 'system-audio',
          sourceCount: 1,
          notes: [],
          statusPath: input.statusPath,
          startedAt: 1,
          durationMs: input.durationMs,
          bucketMs: input.bucketMs,
          marker: { pid: 4242, startTime: 'fixture-start', command: 'fixture-helper' },
        }),
      }),
    };
  };
  const base = f.gateway;
  const originalFacts = await base.inspectFacts(f.device);
  const facts = {
    ...originalFacts,
    operations: { ...originalFacts.operations, audioProbeStart: { available: true as const } },
  };
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    ...base,
    inspectFacts: async () => facts,
    bind: async (input) => {
      const binding = await base.bind(input);
      return { ...binding, facts, operations: { ...binding.operations, audioProbeStart: start } };
    },
  };
  f.setGateway(gateway);
  const scope = await f.scopeFor('audio', undefined, f.workspace);
  const result = await scope.runLocked(
    async () =>
      await handleAudioCommand({
        req: { ...scope.req, positionals: ['probe', 'start', '1000', '500'] },
        sessionName: scope.sessionName,
        sessionStore: f.store,
        inspectFacts: scope.inspectFacts,
        platformServices: scope.platformServices,
        bindDevice: scope.bindDevice,
        audioProbeAdmissionLedger: createAudioProbeAdmissionLedger(),
        throwIfCanceled: scope.throwIfCanceled,
      }),
  );
  await scope[Symbol.asyncDispose]();
  expect(result).toMatchObject({ ok: true, data: { state: 'running' } });
  expect(f.store.requireCurrent(ref).audioProbe).toBeDefined();
  expect(
    audioProbeResourceStore.read(
      audioProbeResourceStore.resolvePath(f.store.resolveSessionDir('recording')),
    ),
  ).toMatchObject({ status: 'decoded', envelope: { lifecycle: 'open' } });
  expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
    ownerToken: original.ownerToken,
    recordingSessionOwner: { pid: process.pid },
  });
});

test('a replacement claim cannot acquire a session owner obligation', async () => {
  const f = createFixture(setup);
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  const fileName = fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'));
  if (!fileName) throw new Error('missing recording claim');
  const claimPath = path.join(f.claimsDir, fileName);
  const original = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  const replacement = { ...original, ownerToken: 'replacement-token' };
  fs.writeFileSync(claimPath, JSON.stringify(replacement));
  await expect(retainSessionOwnerForRecording(f.store, ref)).rejects.toMatchObject({
    code: 'DEVICE_IN_USE',
  });
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toEqual(replacement);
  expect(f.store.requireCurrent(ref).audioProbe).toBeUndefined();
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'an app event retains an unproven owner (before recording: %s, app context resolves: %s)',
  async (beforeRecording, resolveIdentity) => {
    const f = createFixture(setup);
    const ref = f.publish(!beforeRecording);
    if (beforeRecording) {
      const acquired = await acquireDeviceClaim({
        device: f.device,
        session: 'recording',
        workspace: f.workspace,
        stateDir: f.stateDir,
        env: f.host.env,
        reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
      });
      if (acquired.status !== 'acquired') throw new Error('test claim was not acquired');
      f.store.update(ref, { deviceClaim: acquired.ownership });
    } else expect((await f.record('start', f.workspace)).ok).toBe(true);
    const original = inspectDeviceClaims({}, f.host.env)[0]!.claim!;
    expect(original.recordingSessionOwner).toBeUndefined();
    const child: { process?: ChildProcessWithoutNullStreams; exited?: Promise<unknown> } = {};
    const trigger = vi.fn(async () => {
      expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
        ownerToken: original.ownerToken,
        ...(beforeRecording
          ? {}
          : { recordingSessionOwner: { pid: process.pid, startTime: expect.any(String) } }),
        recordingUnresolvedAppEvent: true,
      });
      const app = spawn(
        process.execPath,
        ['-e', String.raw`process.stdout.write('ready\n'); process.stdin.resume()`],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      child.process = app;
      child.exited = once(app, 'exit');
      await once(app.stdout, 'data');
    });
    const base = f.gateway;
    const originalFacts = await base.inspectFacts(f.device);
    const facts = {
      ...originalFacts,
      operations: { ...originalFacts.operations, triggerAppEvent: { available: true as const } },
    };
    const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
      ...base,
      inspectFacts: async () => facts,
      bind: async (input) => {
        const binding = await base.bind(input);
        return {
          ...binding,
          facts,
          operations: { ...binding.operations, triggerAppEvent: trigger },
        };
      },
    };
    f.setGateway(gateway);
    const host = {
      ...f.host,
      env: { ...f.host.env, AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE: 'test://event/{event}' },
    };
    const event = async (name: string) => {
      const request = await f.scopeFor('trigger-app-event', name, f.workspace);
      try {
        return await request.runLocked(
          async () =>
            await handleAppEventCommand({
              host,
              req: request.req,
              sessionName: request.sessionName,
              logPath: request.requestLogPath,
              sessionStore: f.store,
              inspectFacts: request.inspectFacts,
              bindDevice: request.bindDevice,
              platformServices: {
                ...request.platformServices,
                resolveSessionAppBundleIdForTarget: async () =>
                  resolveIdentity ? 'org.example.app' : undefined,
              },
            }),
        );
      } finally {
        await request[Symbol.asyncDispose]();
      }
    };
    try {
      await expect(event('invalid event')).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      expect(trigger).not.toHaveBeenCalled();
      expect(inspectDeviceClaims({}, f.host.env)[0]?.claim?.recordingSessionOwner).toBeUndefined();
      expect(await event('ready')).toMatchObject({ ok: true });
      expect(trigger).toHaveBeenCalledOnce();
      if (beforeRecording) {
        expect(inspectDeviceClaims({}, f.host.env)[0]?.claim).toMatchObject({
          ownerToken: original.ownerToken,
          recordingUnresolvedAppEvent: true,
        });
        expect((await f.record('start', f.workspace)).ok).toBe(true);
      }
      const app = child.process;
      if (!app || !child.exited) throw new Error('test app did not start');
      expect(f.store.requireCurrent(ref).appBundleId).toBe(
        resolveIdentity ? 'org.example.app' : undefined,
      );
      expect((await f.record('stop', f.workspace)).ok).toBe(true);
      const retained = inspectDeviceClaims({}, f.host.env)[0]!.claim!;
      expect(retained).toMatchObject({
        ownerToken: original.ownerToken,
        recordingSessionOwner: { pid: process.pid },
        recordingUnresolvedAppEvent: true,
      });
      expect(await abandonDeviceClaim(f.store.requireCurrent(ref).deviceClaim, f.host.env)).toBe(
        'cleanup-pending',
      );
      const reconcile = createOwnerScopedDeviceClaimReconciler({
        scope: f.scope,
        composeGateway: () => gateway,
      });
      expect(await reconcile(retained)).toMatchObject({
        status: 'retained',
        reason: 'screen-recording-session-owner-pending',
      });
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
      expect(app.exitCode).toBeNull();
      for (const target of [undefined, 'org.example.app']) {
        const close = await f.scopeFor('close', target, f.workspace);
        const outcome = await close
          .runLocked(
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
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        const disposal = await Promise.resolve(close[Symbol.asyncDispose]()).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(outcome).toMatchObject({ error: { details: { reason: 'cleanup-unconfirmed' } } });
        expect(disposal).toBeUndefined();
        expect(f.closeApplication).not.toHaveBeenCalled();
        expect(app.exitCode).toBeNull();
        expect(inspectDeviceClaims({}, f.host.env)[0]?.claim?.ownerToken).toBe(original.ownerToken);
      }
    } finally {
      if (child.process && child.process.exitCode === null && child.process.signalCode === null)
        child.process.kill('SIGKILL');
      await child.exited;
    }
  },
);

test('an app event refuses a replacement claim after binding and before dispatch', async () => {
  const f = createFixture(setup);
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  const entry = inspectDeviceClaims({}, f.host.env)[0]!;
  const claimPath = path.join(f.claimsDir, entry.fileName);
  const replacement = { ...entry.claim!, ownerToken: 'replacement-token' };
  const manifest = fs.readFileSync(f.manifestPath, 'utf8');
  const trigger = vi.fn(async () => {});
  const base = f.gateway;
  const originalFacts = await base.inspectFacts(f.device);
  const facts = {
    ...originalFacts,
    operations: { ...originalFacts.operations, triggerAppEvent: { available: true as const } },
  };
  let bound = false;
  f.setGateway({
    ...base,
    inspectFacts: async () => facts,
    bind: async (input) => {
      const binding = await base.bind(input);
      bound = true;
      return { ...binding, facts, operations: { ...binding.operations, triggerAppEvent: trigger } };
    },
  });
  const host = {
    ...f.host,
    env: {
      ...f.host.env,
      get AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE() {
        expect(bound).toBe(true);
        fs.writeFileSync(claimPath, JSON.stringify(replacement));
        return 'test://event/{event}';
      },
    },
  };
  const request = await f.scopeFor('trigger-app-event', 'ready', f.workspace);
  try {
    await expect(
      request.runLocked(
        async () =>
          await handleAppEventCommand({
            host,
            req: request.req,
            sessionName: request.sessionName,
            logPath: request.requestLogPath,
            sessionStore: f.store,
            inspectFacts: request.inspectFacts,
            bindDevice: request.bindDevice,
            platformServices: request.platformServices,
          }),
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_IN_USE' });
  } finally {
    await request[Symbol.asyncDispose]();
  }
  expect(trigger).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toEqual(replacement);
  expect(fs.readFileSync(f.manifestPath, 'utf8')).toBe(manifest);
  expect(f.store.requireCurrent(ref).appBundleId).toBeUndefined();
});
