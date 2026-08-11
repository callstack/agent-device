import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type { NetworkProviderDump, PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createWebPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'web',
  id: 'web',
  name: 'Browser',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

test('preserves a narrow web provider dump including empty successful entries', async () => {
  const dump: NetworkProviderDump = vi.fn(async () => ({
    backend: 'fixture-web',
    entries: [],
    notes: ['provider note'],
  }));
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed', dump })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });

  await expect(binding.operations.networkDump?.(input())).resolves.toEqual({
    source: 'provider',
    backend: 'fixture-web',
    entries: [],
    notes: ['provider note'],
  });
  expect(binding.facts.device.providerMode).toBe('transport-composed');
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
});

test('keeps a web transport without dumpNetwork unavailable instead of throwing a stub', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.operations.networkDump).toBeUndefined();
  expect(binding.facts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
    hint: 'network is not supported by this web provider',
  });
});

test('binds agent-browser recording only through the focused web transport', async () => {
  const calls: string[] = [];
  const binding = await createWebPlatformRuntime(
    host(
      { mode: 'local' },
      {
        start: async (outputPath) => {
          calls.push(`start:${outputPath}`);
        },
        stop: async () => {
          calls.push('stop');
        },
      },
    ),
  ).bind({ device, intent: { kind: 'ordinary' }, scope: scope() });
  const started = await binding.operations.screenRecordingStart?.({
    sessionId: 'one',
    outputPath: '/tmp/recording.webm',
    scope: 'app',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'one', generation: 1 },
  });
  assert.ok(started);
  await started.pendingHandle.transfer().forceCleanup();
  expect(calls).toEqual(['start:/tmp/recording.webm', 'stop']);
  expect(binding.facts.operations.screenRecordingStart).toEqual({ available: true });
});

test('does not advertise recording without the active agent-browser transport', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'local' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.operations.screenRecordingStart).toBeUndefined();
  expect(binding.facts.operations.screenRecordingStart).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
});

function input() {
  return {
    sessionId: 'one',
    maxEntries: 25,
    include: 'summary' as const,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
  };
}

function scope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

function host(
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
  webRecording: Awaited<
    ReturnType<PlatformRuntimeHost['screenRecording']['web']['resolve']>
  > = undefined,
): PlatformRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    toolchains: { prepare: async () => {} },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    artifacts: {
      resolveSession: () => ({
        outputPath: '/sessions/one/app.log',
        pidPath: '/sessions/one/app-log.pid',
      }),
    },
    outputs: {
      openAppend: async () => {
        throw new Error('unused');
      },
      readTail: async () => '',
    },
    processes: {
      start: async () => {
        throw new Error('unused');
      },
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    processTransports: { resolve: async () => ({ mode: 'local' }) },
    clock: { now: () => 1, sleep: async () => {} },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => transport },
    screenRecording: {
      outputs: { prepare: async () => {} },
      apple: {
        availability: async () => ({ available: true }),
        runRunner: async () => ({}),
        startSimulator: async () => {
          throw new Error('unused');
        },
        inspectProcess: async () => 'missing',
        terminateProcess: async () => 'already-missing',
        inspectRunner: async () => 'missing',
        retrieveRunnerRecording: async () => {},
        captureClockAnchor: async () => undefined,
        isRunnerBundleId: async () => false,
      },
      android: {
        resolve: async () => {
          throw new Error('unused');
        },
      },
      harmony: {
        start: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        stop: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        findMedia: async () => undefined,
        stageMedia: async () => false,
        stagedFileSize: async () => undefined,
        pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        remove: async () => true,
        removeMedia: async () => true,
      },
      web: { resolve: async () => webRecording },
      finalize: { complete: async () => ({}) },
    },
  };
}
