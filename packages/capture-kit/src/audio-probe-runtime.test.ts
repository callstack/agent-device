import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type {
  HostAudioCaptureProcess,
  HostSystemAudioCaptureHost,
} from '@agent-device/contracts/audio-probe-runtime-host';
import type { HostCommandResult, ManagedProcessIdentity } from '@agent-device/contracts/platform';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { hostAudioProbeDescriptorCodec } from './audio-probe-descriptor.ts';
import { createHostAudioProbeRecoveryOperations } from './audio-probe-recovery.ts';
import { startHostAudioProbe } from './audio-probe-runtime.ts';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
} from './durable-resource-envelope.ts';

const device: DeviceInfo = {
  id: 'macos-host',
  name: 'macOS',
  platform: 'apple',
  appleOs: 'macos',
  kind: 'device',
};
const owner = { kind: 'local-family', family: 'apple' } as const;
const fence = { token: 'fence-1', generation: 1 } as const;
const marker: ManagedProcessIdentity = { pid: 4242, startTime: 'boot+1', command: 'helper' };

const descriptorBody = {
  backend: 'macos-screencapturekit',
  source: 'system-audio',
  sourceCount: 1,
  notes: ['note'],
  statusPath: '/tmp/audio-probe.json',
  startedAt: 1_700_000_000_000,
  durationMs: 10_000,
  bucketMs: 1_000,
  marker: { ...marker },
} as const;

function envelopeWith(body: object) {
  return createDurableResourceEnvelope({
    resourceKind: 'audio-probe',
    sessionId: 's1',
    device: deviceIdentity(device),
    owner,
    fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: body as never },
  });
}

async function withStatusDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-probe-kit-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeHost(overrides: Partial<HostSystemAudioCaptureHost> = {}): HostSystemAudioCaptureHost {
  return Object.freeze({
    info: Object.freeze({
      source: 'system-audio' as const,
      backend: 'macos-screencapturekit',
      sourceCount: 1,
      notes: () => ['note'],
    }),
    start: async () => {
      throw new Error('start not faked');
    },
    inspectProcess: async () => 'missing' as const,
    terminateProcess: async () => 'already-missing' as const,
    ...overrides,
  });
}

test('descriptor codec round-trips and rejects malformed bodies', () => {
  const encoded = encodeDurableDescriptor(hostAudioProbeDescriptorCodec, descriptorBody);
  const decoded = hostAudioProbeDescriptorCodec.decode(encoded.body);
  assert.equal(decoded.status, 'decoded');
  if (decoded.status === 'decoded') assert.deepEqual(decoded.descriptor, descriptorBody);

  for (const broken of [
    { ...descriptorBody, backend: '' },
    { ...descriptorBody, source: 'radio' },
    { ...descriptorBody, statusPath: 42 },
    { ...descriptorBody, marker: { pid: 'x' } },
    { ...descriptorBody, marker: undefined },
  ]) {
    assert.equal(hostAudioProbeDescriptorCodec.decode(broken as never).status, 'invalid');
  }
});

// Restart-after-stop reuses the session's status path; without the pre-spawn clear, the previous
// run's file satisfies the first-status wait and the new probe reports the old run's snapshot.
test('start never adopts a stale status file from a previous probe', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    await fs.writeFile(
      statusPath,
      JSON.stringify({ state: 'stopped', rmsDbfs: [-9], peakDbfs: [-4], sampleCount: 40 }),
    );
    let terminated = 0;
    const host = fakeHost({
      start: async () => ({
        marker,
        wait: Promise.resolve({
          stdout: '',
          stderr: 'sampler died before publishing',
          exitCode: 1,
        }),
        terminate: async () => {
          terminated += 1;
        },
      }),
    });

    await assert.rejects(
      startHostAudioProbe({
        host,
        device,
        owner,
        input: { sessionId: 's1', statusPath, durationMs: 1000, bucketMs: 500, fence },
      }),
      /sampler died before publishing/,
    );
    assert.equal(terminated, 1);
    await assert.rejects(fs.access(statusPath), 'the stale status file must be cleared');
  });
});

test('start terminates a sampler whose exact process identity cannot be resolved', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    let terminated = 0;
    const host = fakeHost({
      start: async (input) => {
        await fs.writeFile(
          input.statusPath,
          JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
        );
        let exit: (result: HostCommandResult) => void = () => {};
        const wait = new Promise<HostCommandResult>((resolve) => {
          exit = resolve;
        });
        return {
          wait,
          terminate: async () => {
            terminated += 1;
            exit({ stdout: '', stderr: '', exitCode: 0 });
          },
        } satisfies HostAudioCaptureProcess;
      },
    });

    await assert.rejects(
      startHostAudioProbe({
        host,
        device,
        owner,
        input: { sessionId: 's1', statusPath, durationMs: 1000, bucketMs: 500, fence },
      }),
      /exposed no exact identity/,
    );
    assert.equal(terminated, 1);
  });
});

// A helper that dies after its first running checkpoint must surface as a failure: without the
// exit observation, status reads the stale checkpoint as running forever and stop fabricates a
// normal completion for a capture that was lost.
test('a helper that dies after a running checkpoint is surfaced, never completed', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    let exitHelper: (result: HostCommandResult) => void = () => {};
    const host = fakeHost({
      start: async (input) => {
        await fs.writeFile(
          input.statusPath,
          JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
        );
        return {
          marker,
          wait: new Promise<HostCommandResult>((resolve) => {
            exitHelper = resolve;
          }),
          terminate: async () => {},
        } satisfies HostAudioCaptureProcess;
      },
    });

    const started = await startHostAudioProbe({
      host,
      device,
      owner,
      input: { sessionId: 's1', statusPath, durationMs: 1000, bucketMs: 500, fence },
    });
    const handle = started.pendingHandle.transfer();
    assert.equal((await handle.status()).state, 'running');

    exitHelper({ stdout: '', stderr: 'sampler crashed', exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await assert.rejects(handle.status(), /sampler crashed/);
    await assert.rejects(handle.finish(), /sampler crashed/);
    assert.deepEqual(await handle.forceCleanup(), { status: 'cleaned' });
  });
});

// A markerless record (foreign or corrupted — start never publishes one) must never be treated as
// finished or absent: recovery can neither prove the child exited nor terminate it by identity.
test('a markerless record with a live status file is never read as completed or missing', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    await fs.writeFile(
      statusPath,
      JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
    );
    const { marker: _dropped, ...markerless } = { ...descriptorBody, statusPath };
    const inspected: ManagedProcessIdentity[] = [];
    const recovery = createHostAudioProbeRecoveryOperations({
      host: fakeHost({
        inspectProcess: async (target) => {
          inspected.push(target);
          return 'missing' as const;
        },
      }),
    });

    const reattached = await recovery.audioProbeReattach({ envelope: envelopeWith(markerless) });
    assert.equal(reattached.status, 'unreattachable');
    if (reattached.status === 'unreattachable') {
      assert.equal(reattached.reason, 'descriptor-invalid');
    }

    const cleaned = await recovery.audioProbeCleanup({ envelope: envelopeWith(markerless) });
    assert.equal(cleaned.status, 'cleanup-pending');
    if (cleaned.status === 'cleanup-pending') {
      assert.equal(cleaned.reason, 'manual-recovery-required');
    }
    assert.deepEqual(inspected, []);
  });
});

test('start publishes handle and envelope only after the sampler writes status', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    let terminated = 0;
    const host = fakeHost({
      start: async (input) => {
        await fs.writeFile(
          input.statusPath,
          JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
        );
        let exit: (result: HostCommandResult) => void = () => {};
        const wait = new Promise<HostCommandResult>((resolve) => {
          exit = resolve;
        });
        return {
          marker,
          wait,
          terminate: async () => {
            terminated += 1;
            exit({ stdout: '', stderr: '', exitCode: 0 });
          },
        } satisfies HostAudioCaptureProcess;
      },
    });

    const started = await startHostAudioProbe({
      host,
      device,
      owner,
      input: { sessionId: 's1', statusPath, durationMs: 1000, bucketMs: 500, fence },
    });
    assert.equal(started.envelope.lifecycle, 'open');
    assert.equal(started.envelope.fence.token, 'fence-1');
    const decoded = hostAudioProbeDescriptorCodec.decode(started.envelope.descriptor.body);
    assert.equal(decoded.status, 'decoded');
    if (decoded.status === 'decoded') assert.deepEqual(decoded.descriptor.marker, marker);

    const handle = started.pendingHandle.transfer();
    const status = await handle.status();
    assert.equal(status.state, 'running');
    assert.deepEqual(status.rmsDbfs, [-10]);

    const finish = await handle.finish();
    assert.equal(finish.status, 'completed');
    if (finish.status === 'completed') {
      assert.equal(finish.result.state, 'stopped');
      assert.equal(finish.result.reason, 'stopped');
    }
    assert.equal(terminated, 1);
    // finish is idempotent and forceCleanup after finish confirms without a second kill
    await handle.finish();
    assert.equal(terminated, 1);
    assert.deepEqual(await handle.forceCleanup(), { status: 'cleaned' });
  });
});

test('start fails and terminates the sampler when it exits before publishing', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    let terminated = 0;
    const host = fakeHost({
      start: async () => ({
        marker,
        wait: Promise.resolve({ stdout: '', stderr: 'permission denied', exitCode: 1 }),
        terminate: async () => {
          terminated += 1;
        },
      }),
    });

    await assert.rejects(
      startHostAudioProbe({
        host,
        device,
        owner,
        input: { sessionId: 's1', statusPath, durationMs: 1000, bucketMs: 500, fence },
      }),
      /permission denied/,
    );
    assert.equal(terminated, 1);
  });
});

test('reattach is cleanup-only: live sampler unreattachable, finished run completes', async () => {
  await withStatusDir(async (dir) => {
    const statusPath = path.join(dir, 'audio-probe.json');
    const body = { ...descriptorBody, statusPath };

    const live = createHostAudioProbeRecoveryOperations({
      host: fakeHost({ inspectProcess: async () => 'owned-alive' as const }),
    });
    assert.deepEqual(await live.audioProbeReattach({ envelope: envelopeWith(body) }), {
      status: 'unreattachable',
      reason: 'transport-not-reattachable',
    });

    const lost = createHostAudioProbeRecoveryOperations({
      host: fakeHost({ inspectProcess: async () => 'ownership-lost' as const }),
    });
    assert.deepEqual(await lost.audioProbeReattach({ envelope: envelopeWith(body) }), {
      status: 'unreattachable',
      reason: 'ownership-fence-lost',
    });

    const gone = createHostAudioProbeRecoveryOperations({ host: fakeHost() });
    assert.deepEqual(await gone.audioProbeReattach({ envelope: envelopeWith(body) }), {
      status: 'missing',
    });

    // A running checkpoint with the child gone is a mid-capture death, not a completion.
    await fs.writeFile(
      statusPath,
      JSON.stringify({ state: 'running', rmsDbfs: [-10], peakDbfs: [-5], sampleCount: 1 }),
    );
    assert.deepEqual(await gone.audioProbeReattach({ envelope: envelopeWith(body) }), {
      status: 'missing',
    });

    await fs.writeFile(
      statusPath,
      JSON.stringify({ state: 'stopped', rmsDbfs: [-9], peakDbfs: [-4], sampleCount: 3 }),
    );
    const completed = await gone.audioProbeReattach({ envelope: envelopeWith(body) });
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
      assert.equal(completed.result.state, 'stopped');
      assert.equal(completed.result.reason, 'daemon-recovery');
      assert.deepEqual(completed.result.rmsDbfs, [-9]);
    }
  });
});

test('cleanup terminates by exact identity and fails closed on lost ownership', async () => {
  const cleanedCalls: ManagedProcessIdentity[] = [];
  const alive = createHostAudioProbeRecoveryOperations({
    host: fakeHost({
      inspectProcess: async () => 'owned-alive' as const,
      terminateProcess: async (target) => {
        cleanedCalls.push(target);
        return 'terminated' as const;
      },
    }),
  });
  assert.deepEqual(await alive.audioProbeCleanup({ envelope: envelopeWith(descriptorBody) }), {
    status: 'cleaned',
  });
  assert.deepEqual(cleanedCalls, [marker]);

  const lost = createHostAudioProbeRecoveryOperations({
    host: fakeHost({ inspectProcess: async () => 'ownership-lost' as const }),
  });
  assert.deepEqual(await lost.audioProbeCleanup({ envelope: envelopeWith(descriptorBody) }), {
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
  });

  const missing = createHostAudioProbeRecoveryOperations({ host: fakeHost() });
  assert.deepEqual(await missing.audioProbeCleanup({ envelope: envelopeWith(descriptorBody) }), {
    status: 'already-missing',
  });

  const invalid = await missing.audioProbeCleanup({
    envelope: envelopeWith({ ...descriptorBody, backend: '' }),
  });
  assert.equal(invalid.status, 'cleanup-pending');
  if (invalid.status === 'cleanup-pending') {
    assert.equal(invalid.reason, 'manual-recovery-required');
  }
});
