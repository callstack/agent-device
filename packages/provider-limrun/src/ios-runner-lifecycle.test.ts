import { expect, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime } from './runtime.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import { stubLimrunRuntimeDependencies } from './runtime-dependencies.fixtures.ts';
import { testIosRunner } from './ios-runner.fixtures.ts';

const clients = vi.hoisted(() => ({ disconnect: vi.fn(), deleteInstance: vi.fn(async () => {}) }));
vi.mock('@limrun/api', () => ({
  default: class {
    iosInstances = {
      create: async () => ({
        metadata: { id: 'ios_test' },
        status: { apiUrl: 'https://sim.example/api', token: 'instance-token' },
      }),
      delete: clients.deleteInstance,
    };
  },
}));
vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: async () => ({ disconnect: clients.disconnect }),
}));

for (const attached of [false, true]) {
  test(`releases an ${attached ? 'attached' : 'owned'} simulator lease when runner creation fails`, async () => {
    clients.disconnect.mockClear();
    clients.deleteInstance.mockClear();
    const runtime = createLimrunRuntime(
      {
        apiKey: 'api-key',
        ...(attached
          ? { instances: { ios: { apiUrl: 'https://sim.example/api', token: 'instance-token' } } }
          : {}),
      },
      {
        clientVersion: 'test',
        android: {},
        host: {},
        ios: {
          createRunner: async () => {
            throw new Error('runner unavailable');
          },
        },
      } as unknown as LimrunRuntimeDependencies,
    );
    const lease: DeviceLease = {
      leaseId: 'lease-ios',
      tenantId: 'test',
      runId: 'run',
      backend: 'ios-instance',
      leaseProvider: 'limrun',
      createdAt: 1,
      heartbeatAt: 1,
      expiresAt: 60001,
    };
    try {
      await expect(runtime.leaseLifecycle.allocate!(lease)).rejects.toThrow('runner unavailable');
      expect(clients.disconnect).toHaveBeenCalledTimes(1);
      expect(clients.deleteInstance).toHaveBeenCalledTimes(attached ? 0 : 1);
    } finally {
      await runtime.shutdown();
    }
  });
}

for (const attached of [false, true]) {
  test(`one teardown stops the ${attached ? 'attached' : 'owned'} simulator runner before disconnect`, async () => {
    clients.disconnect.mockClear();
    clients.deleteInstance.mockClear();
    const dependencies = stubLimrunRuntimeDependencies();
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let reportStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      reportStopped = resolve;
    });
    const dispose = vi.fn(async () => {
      reportStarted();
      await stopped;
    });
    const runtime = createLimrunRuntime(
      {
        apiKey: 'api-key',
        ...(attached
          ? { instances: { ios: { apiUrl: 'https://sim.example/api', token: 'instance-token' } } }
          : {}),
      },
      {
        ...dependencies,
        ios: { ...dependencies.ios, createRunner: async () => ({ ...testIosRunner, dispose }) },
      },
    );
    const lease: DeviceLease = {
      leaseId: 'lease-ios-dispose',
      tenantId: 'test',
      runId: 'run',
      backend: 'ios-instance',
      leaseProvider: 'limrun',
      createdAt: 1,
      heartbeatAt: 1,
      expiresAt: 60001,
    };
    try {
      await runtime.leaseLifecycle.allocate!(lease);
      const release = runtime.leaseLifecycle.release!(lease);
      const shutdown = runtime.shutdown();
      await started;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(clients.disconnect).not.toHaveBeenCalled();
      expect(clients.deleteInstance).toHaveBeenCalledTimes(attached ? 0 : 1);
      reportStopped();
      await Promise.all([release, shutdown]);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(clients.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      reportStopped();
      await runtime.shutdown();
    }
  });
}
