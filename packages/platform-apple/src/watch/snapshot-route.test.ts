import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { platformRuntimeHostFixture } from '../runtime.fixtures.ts';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createAppleSnapshotRoute } from '../snapshot-route.ts';
import type { SimulatorSnapshotSource } from '../snapshot-source-facade.ts';

const watch = {
  platform: 'apple',
  appleOs: 'watchos',
  id: 'watch-1',
  name: 'Apple Watch',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

const target = {
  simulator: simulatorAddressFor(watch),
  runtime: 'watchOS 26.0',
  pid: 42,
  generation: '42:launch-a',
  targetId: `${watch.id}:com.example.app`,
  processStartTime: 'target-start',
} as const;

const input = { options: { appBundleId: 'com.example.app' } } as const;

function sourceReturning(
  outcome: Awaited<ReturnType<SimulatorSnapshotSource['acquire']>>,
): SimulatorSnapshotSource {
  return { acquire: vi.fn(async () => outcome), close: vi.fn(async () => {}) };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

test('watchOS bridge failures preserve their failure code instead of claiming unsupported fallback', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: {
      kind: 'transport-failure',
      code: 'bridge-disconnected',
      details: { reason: 'untrusted-detail', deviceId: 'untrusted-device' },
    },
  });
  const fallback = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'apple-runner' as const,
    nodes: [],
  }));
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget: vi.fn(async () => target),
  });

  await expect(route.capture(watch, input, signal(), fallback)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'watchos-ax-bridge-failed',
      bridgeFailureCode: 'bridge-disconnected',
    },
  });
  expect(fallback).not.toHaveBeenCalled();
});

test('watchOS bridge preparation is reported as a retriable state, not a bridge failure', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: {
      kind: 'preparing',
      code: 'bridge-preparation-pending',
      details: { reason: 'untrusted-detail', retryable: false },
    },
  });
  const fallback = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'apple-runner' as const,
    nodes: [],
  }));
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget: vi.fn(async () => target),
  });

  await expect(route.capture(watch, input, signal(), fallback)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'watchos-ax-bridge-preparing',
      deviceId: watch.id,
      bridgeFailureCode: 'bridge-preparation-pending',
      retryable: true,
    },
  });
  expect(fallback).not.toHaveBeenCalled();
});
