import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
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
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { handleAudioCommand } from './session-observability/internal/session-audio.ts';
import { isolatedDeviceClaimStores } from '../__tests__/support/device-claim-store.ts';
import { fixture as createFixture } from '../resources/device/__tests__/device-claim-admission-ownership.fixtures.ts';
import { retainSessionOwnerForRecording } from './recording-session-owner.ts';

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
