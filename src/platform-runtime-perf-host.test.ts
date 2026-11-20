import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { createPerfRuntimeHost } from './platform-runtime-perf-host.ts';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';

const adb = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  const { AppError } = await import('@agent-device/kernel/errors');
  return {
    ...actual,
    runCmd: async (command: string, args: string[]) => {
      adb.calls.push([command, ...args]);
      throw new AppError('COMMAND_FAILED', 'Remote Android ADB executor is unavailable');
    },
  };
});

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('exposes family-specific mechanics without a bind or platform switch surface', () => {
  const host = createPerfRuntimeHost();

  expect(Object.keys(host).sort()).toEqual(['android', 'apple', 'harmony']);
  expect(host).not.toHaveProperty('bind');
  expect(Object.keys(host.apple)).toContain('frameSampling');
  expect(Object.keys(host.android)).not.toContain('frameSampling');
  expect(Object.keys(host.harmony)).toEqual(['sampleMemory']);
});

test('the composed Android perf operation reports an unavailable ADB memory sample', async () => {
  adb.calls.length = 0;
  const sessionsDir = mkdtempForTestSync('platform-runtime-perf-host-');
  const gateway = createPlatformRuntimeGateway({
    host: createLiveTestHostEnvironment(),
    sessionsDir,
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: `${sessionsDir}/${sessionId}/app.log`,
      pidPath: `${sessionsDir}/${sessionId}/app-log.pid`,
    }),
  });

  try {
    const binding = await gateway.bind({ device, intent: { kind: 'ordinary' }, scope });
    const sampleMemory = binding.operations.perfMemorySample;
    expect(sampleMemory).toBeDefined();
    if (!sampleMemory) throw new Error('Android memory sampling was not bound');
    const result = await sampleMemory({ appId: 'com.example.app' });

    expect(result.metric).toMatchObject({
      available: false,
      reason: 'Remote Android ADB executor is unavailable',
      error: { details: { metric: 'memory' } },
    });
    expect(
      adb.calls.some(([command, ...args]) => command === 'adb' && args.includes('dumpsys')),
    ).toBe(true);
  } finally {
    await gateway.shutdown();
  }
});

bindTestCommandHost();
