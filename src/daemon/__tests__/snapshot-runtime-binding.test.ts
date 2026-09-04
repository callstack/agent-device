import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { resolveSnapshotRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import type { BindDeviceRuntime } from '../request-runtime-binding.ts';
import {
  admitAndBindSnapshotCapture,
  resolveBoundSnapshotCaptureRuntime,
} from '../snapshot-runtime-binding.ts';
import type { DaemonRequest } from '../types.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';
import { ensureDeviceReady } from '../device-ready.ts';

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);

// The owning interface (ADR 0019 §9): one plan, one facts-first admission, one bind — and the
// bind target is whatever the admission was minted for, read back by token identity. The binder
// itself is module-private; this is its only entry.
test('the owning interface binds exactly the session device the facts were admitted for', async () => {
  const { inspectFacts, bindDevice } = snapshotRuntimeFixture();
  const boundDevices: DeviceInfo[] = [];
  const recordingBind: BindDeviceRuntime = async (device, use) => {
    boundDevices.push(device);
    return await bindDevice(device, use);
  };
  const sessionStore = makeSessionStore();
  // An active app: the fixture admits captureSnapshot for a local iOS simulator only with one.
  sessionStore.set(
    'bind-test',
    makeIosSession('bind-test', { device: IOS_SIMULATOR, appBundleId: 'com.example.app' }),
  );
  const req: DaemonRequest = {
    command: 'snapshot',
    positionals: [],
    session: 'bind-test',
    token: 'test-token',
  };

  const resolved = await resolveBoundSnapshotCaptureRuntime(
    {
      req,
      sessionName: 'bind-test',
      logPath: '/tmp/bind-test.log',
      sessionStore,
      inspectFacts,
      bindDevice: recordingBind,
    },
    'snapshot',
  );

  expect(resolved.ok).toBe(true);
  expect(boundDevices).toEqual([IOS_SIMULATOR]);
});

test('sessionless capture readiness follows runtime binding', async () => {
  const fixture = snapshotRuntimeFixture();
  const events: string[] = [];
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockImplementation(async () => {
    events.push('ready');
  });
  const recordingBind: BindDeviceRuntime = async (device, use) => {
    events.push('bind');
    return await fixture.bindDevice(device, use);
  };

  const resolved = await admitAndBindSnapshotCapture({
    command: 'snapshot',
    device: IOS_SIMULATOR,
    session: undefined,
    plan: resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true }),
    inspectFacts: fixture.inspectFacts,
    bindDevice: recordingBind,
    readiness: {},
  });

  expect(resolved.ok).toBe(true);
  expect(events).toEqual(['bind', 'ready']);
});
