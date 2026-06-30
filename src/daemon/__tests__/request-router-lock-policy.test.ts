import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { dispatchCommand } from '../../core/dispatch.ts';
import { createRequestHandler } from '../request-router.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

const mockDispatch = vi.mocked(dispatchCommand);

function makeIosSession(name: string): SessionState {
  return {
    name,
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'ios',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/set',
    },
  };
}

function makeAndroidSession(name: string, id = 'emulator-5554'): SessionState {
  return {
    name,
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      target: 'mobile',
      id,
      name: id === 'emulator-5554' ? 'Pixel 9 Pro XL' : 'Pixel 8',
      kind: 'emulator',
      booted: true,
    },
  };
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({ nodes: [] });
});

function installGatedDispatch(): {
  order: string[];
  getMaxActive: () => number;
  releaseNext: () => void;
} {
  const order: string[] = [];
  const gates: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;

  mockDispatch.mockImplementation(async (device, command) => {
    order.push(`start-${command}-${device.id}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      gates.push(() => {
        active -= 1;
        order.push(`end-${command}-${device.id}`);
        resolve();
      });
    });
    return { nodes: [] };
  });

  return {
    order,
    getMaxActive: () => maxActive,
    releaseNext: () => {
      gates.shift()?.();
    },
  };
}

test('direct daemon requests cannot bypass reject lock policy for existing sessions', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  sessionStore.set('qa-ios', makeIosSession('qa-ios'));

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'qa-ios',
    command: 'home',
    positionals: [],
    flags: {
      udid: 'SIM-999',
    },
    meta: {
      lockPolicy: 'reject',
    },
  });

  expect(mockDispatch).not.toHaveBeenCalled();
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/--udid=SIM-999/i);
    expect(response.error.hint).toMatch(/agent-device session list/i);
    expect(response.error.hint).toMatch(/agent-device close --session qa-ios/i);
  }
});

test('fresh named sessions with matching explicit serial bind and serialize on the selected device', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  const dispatchGate = installGatedDispatch();

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryProvider: async () => [makeAndroidSession('inventory').device],
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const first = handler({
    token: 'test-token',
    session: 'qa-android-a',
    command: 'snapshot',
    positionals: [],
    flags: {
      serial: 'emulator-5554',
    },
    meta: {
      requestId: 'req-fresh-lock-a',
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  await vi.waitFor(() => {
    expect(dispatchGate.order).toEqual(['start-snapshot-emulator-5554']);
  });

  const second = handler({
    token: 'test-token',
    session: 'qa-android-b',
    command: 'snapshot',
    positionals: [],
    flags: {
      serial: 'emulator-5554',
    },
    meta: {
      requestId: 'req-fresh-lock-b',
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dispatchGate.order).toEqual(['start-snapshot-emulator-5554']);

  dispatchGate.releaseNext();

  await vi.waitFor(() => {
    expect(dispatchGate.order).toEqual([
      'start-snapshot-emulator-5554',
      'end-snapshot-emulator-5554',
      'start-snapshot-emulator-5554',
    ]);
  });

  dispatchGate.releaseNext();

  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  expect(firstResponse.ok).toBe(true);
  expect(secondResponse.ok).toBe(true);
  expect(dispatchGate.getMaxActive()).toBe(1);
  expect(sessionStore.get('qa-android-a')?.device.id).toBe('emulator-5554');
  expect(sessionStore.get('qa-android-b')?.device.id).toBe('emulator-5554');
});

test('fresh named sessions with the same name serialize first binding before rejecting another device', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  const firstDevice = makeAndroidSession('inventory').device;
  const secondDevice: SessionState['device'] = {
    ...makeAndroidSession('inventory-2', 'emulator-5556').device,
  };
  const dispatchGate = installGatedDispatch();

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryProvider: async () => [firstDevice, secondDevice],
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const first = handler({
    token: 'test-token',
    session: 'qa-android',
    command: 'snapshot',
    positionals: [],
    flags: {
      serial: 'emulator-5554',
    },
    meta: {
      requestId: 'req-fresh-same-session-a',
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  await vi.waitFor(() => {
    expect(dispatchGate.order).toEqual(['start-snapshot-emulator-5554']);
  });

  const second = handler({
    token: 'test-token',
    session: 'qa-android',
    command: 'snapshot',
    positionals: [],
    flags: {
      serial: 'emulator-5556',
    },
    meta: {
      requestId: 'req-fresh-same-session-b',
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dispatchGate.order).toEqual(['start-snapshot-emulator-5554']);

  dispatchGate.releaseNext();

  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  expect(firstResponse.ok).toBe(true);
  expect(secondResponse.ok).toBe(false);
  if (!secondResponse.ok) {
    expect(secondResponse.error.code).toBe('INVALID_ARGS');
    expect(secondResponse.error.message).toMatch(/--serial=emulator-5556/i);
  }
  expect(dispatchGate.order).toEqual([
    'start-snapshot-emulator-5554',
    'end-snapshot-emulator-5554',
  ]);
  expect(dispatchGate.getMaxActive()).toBe(1);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(sessionStore.get('qa-android')?.device.id).toBe('emulator-5554');
});

test('fresh named sessions with only lock platform default serialize on the selected device', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  const dispatchGate = installGatedDispatch();

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryProvider: async () => [makeAndroidSession('inventory').device],
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const first = handler({
    token: 'test-token',
    session: 'qa-default-a',
    command: 'snapshot',
    positionals: [],
    flags: {},
    meta: {
      requestId: 'req-fresh-default-lock-a',
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  await vi.waitFor(() => {
    expect(dispatchGate.order).toEqual(['start-snapshot-emulator-5554']);
  });

  const second = handler({
    token: 'test-token',
    session: 'qa-default-b',
    command: 'snapshot',
    positionals: [],
    flags: {},
    meta: {
      requestId: 'req-fresh-default-lock-b',
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dispatchGate.order).toEqual(['start-snapshot-emulator-5554']);

  dispatchGate.releaseNext();

  await vi.waitFor(() => {
    expect(dispatchGate.order).toEqual([
      'start-snapshot-emulator-5554',
      'end-snapshot-emulator-5554',
      'start-snapshot-emulator-5554',
    ]);
  });

  dispatchGate.releaseNext();

  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  expect(firstResponse.ok).toBe(true);
  expect(secondResponse.ok).toBe(true);
  expect(dispatchGate.getMaxActive()).toBe(1);
  expect(sessionStore.get('qa-default-a')?.device.id).toBe('emulator-5554');
  expect(sessionStore.get('qa-default-b')?.device.id).toBe('emulator-5554');
});

test('fresh named sessions reject incompatible selector combinations before binding', async () => {
  const cases = [
    {
      name: 'ios-serial',
      flags: { serial: 'emulator-5554' },
      meta: { lockPolicy: 'reject', lockPlatform: 'ios' },
      conflict: /--serial=emulator-5554/i,
    },
    {
      name: 'ios-android-platform',
      flags: { platform: 'android', udid: 'SIM-001' },
      meta: { lockPolicy: 'reject', lockPlatform: 'ios' },
      conflict: /--platform=android/i,
    },
    {
      name: 'ios-desktop-target',
      flags: { target: 'desktop' },
      meta: { lockPolicy: 'reject', lockPlatform: 'ios' },
      conflict: /--target=desktop/i,
    },
    {
      name: 'macos-udid',
      flags: { udid: 'SIM-001', iosSimulatorDeviceSet: '/tmp/tenant-a/set' },
      meta: { lockPolicy: 'reject', lockPlatform: 'macos' },
      conflict: /--udid=SIM-001/i,
    },
    {
      name: 'apple-macos-udid',
      flags: { platform: 'macos', udid: 'SIM-001' },
      meta: { lockPolicy: 'reject', lockPlatform: 'apple' },
      conflict: /--udid=SIM-001/i,
    },
    {
      name: 'apple-macos-simulator-set',
      flags: { platform: 'macos', iosSimulatorDeviceSet: '/tmp/tenant-a/set' },
      meta: { lockPolicy: 'reject', lockPlatform: 'apple' },
      conflict: /--ios-simulator-device-set=\/tmp\/tenant-a\/set/i,
    },
  ] as const;

  for (const testCase of cases) {
    const sessionStore = makeSessionStore('agent-device-router-lock-');
    const handler = createRequestHandler({
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryProvider: async () => [makeIosSession('inventory').device],
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const response = await handler({
      token: 'test-token',
      session: testCase.name,
      command: 'snapshot',
      positionals: [],
      flags: testCase.flags,
      meta: {
        requestId: `req-${testCase.name}`,
        ...testCase.meta,
      },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_ARGS');
      expect(response.error.message).toMatch(testCase.conflict);
    }
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(sessionStore.get(testCase.name)).toBeUndefined();
    mockDispatch.mockClear();
  }
});

test('batch steps cannot bypass reject lock policy on nested direct requests', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  sessionStore.set('qa-ios', makeIosSession('qa-ios'));

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'qa-ios',
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        {
          command: 'home',
          flags: {
            serial: 'emulator-5554',
          },
        },
      ],
    },
    meta: {
      lockPolicy: 'reject',
    },
  });

  expect(mockDispatch).not.toHaveBeenCalled();
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/Batch failed at step 1/i);
    expect(response.error.message).toMatch(/--serial=emulator-5554/i);
    expect(response.error.hint).toMatch(/agent-device session list/i);
    expect(response.error.hint).toMatch(/agent-device close --session qa-ios/i);
  }
});

test('direct daemon requests apply strip lock policy for existing sessions before dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  sessionStore.set('qa-ios', makeIosSession('qa-ios'));
  let dispatchCalls = 0;
  mockDispatch.mockImplementation(async () => {
    dispatchCalls += 1;
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'qa-ios',
    command: 'home',
    positionals: [],
    flags: {
      target: 'tv',
      udid: 'SIM-999',
      device: 'iPhone 16',
    },
    meta: {
      lockPolicy: 'strip',
    },
  });

  expect(dispatchCalls).toBe(1);
  expect(response.ok).toBe(true);
  const action = sessionStore.get('qa-ios')?.actions.at(-1);
  expect(action?.flags.platform).toBe('ios');
  expect(action?.flags.udid).toBe(undefined);
  expect(action?.flags.target).toBe(undefined);
  expect(action?.flags.device).toBe('iPhone 16');
});

test('batch preserves tenant-scoped session names across nested requests', async () => {
  const sessionStore = makeSessionStore('agent-device-router-lock-');
  sessionStore.set('tenant-a:default', makeIosSession('tenant-a:default'));
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
  });
  let dispatchCalls = 0;
  mockDispatch.mockImplementation(async () => {
    dispatchCalls += 1;
    return {};
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [{ command: 'home' }],
    },
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseId: lease.leaseId,
      sessionIsolation: 'tenant',
    },
  });

  expect(response.ok).toBe(true);
  expect(dispatchCalls).toBe(1);
  expect(sessionStore.get('tenant-a:default')?.actions.at(-1)?.command).toBe('home');
});
