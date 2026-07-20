import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(), resolveTargetDevice: vi.fn() };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-hints.ts')>();
  return { ...actual, applyRuntimeHintsToApp: vi.fn(async () => {}) };
});
vi.mock('../session-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn() };
});
vi.mock('../../../platforms/android/ime-lifecycle.ts', () => ({
  activateAndroidTestIme: vi.fn(async () => {}),
  restoreAndroidTestIme: vi.fn(async () => ({ restored: false, reason: 'no-record' })),
}));

import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import { applyRuntimeHintsToApp } from '../../runtime-hints.ts';
import { resolveAndroidPackageForOpen } from '../session-open-target.ts';
import { activateAndroidTestIme } from '../../../platforms/android/ime-lifecycle.ts';
import { clearRequestCanceled, markRequestCanceled } from '../../../request/cancel.ts';
import { acquireAdvisoryDeviceClaim } from '../../device-claims.ts';
import { inspectDeviceClaims } from '../../device-claim-inspection.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { SessionStore } from '../../session-store.ts';
import { handleCloseCommand } from '../session-close.ts';
import { handleOpenCommand } from '../session-open.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintsToApp);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockApplyRuntimeHints.mockResolvedValue(undefined);
  mockResolveAndroidPackage.mockResolvedValue(undefined);
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): { store: SessionStore; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-device-claim-'));
  const claimsDir = path.join(stateDir, 'claims');
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  roots.push(stateDir);
  return { store: new SessionStore(path.join(stateDir, 'sessions')), stateDir };
}

const android: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

test('failed local open before device setup rolls its advisory claim back', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockEnsureDeviceReady.mockRejectedValue(new Error('device not ready'));

  await assert.rejects(async () =>
    handleOpenCommand({
      req: {
        command: 'open',
        token: 'test',
        session: 'claim-rollback',
        positionals: ['Demo'],
        flags: { platform: 'android' },
      },
      sessionName: 'claim-rollback',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
    }),
  );
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
});

test('failed local open after dispatch retains its advisory claim for recovery', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockRejectedValue(new Error('open failed'));

  await assert.rejects(async () =>
    handleOpenCommand({
      req: {
        command: 'open',
        token: 'test',
        session: 'claim-dispatch-failure',
        positionals: ['Demo'],
        flags: { platform: 'android' },
      },
      sessionName: 'claim-dispatch-failure',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
    }),
  );
  assert.equal(inspectDeviceClaims({ serial: android.id })[0]?.classification, 'live');
});

test('failed local runtime-hint setup retains its advisory claim before open dispatch', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  mockApplyRuntimeHints.mockRejectedValue(new Error('runtime hints changed before failure'));

  await assert.rejects(async () =>
    handleOpenCommand({
      req: {
        command: 'open',
        token: 'test',
        session: 'claim-runtime-hint-failure',
        positionals: ['Demo'],
        flags: { platform: 'android' },
        runtime: { metroHost: '10.0.0.10', metroPort: 8081 },
      },
      sessionName: 'claim-runtime-hint-failure',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
    }),
  );

  assert.equal(mockApplyRuntimeHints.mock.calls.length, 1);
  assert.equal(mockDispatch.mock.calls.length, 0);
  assert.equal(inspectDeviceClaims({ serial: android.id })[0]?.classification, 'live');
  assert.equal(store.get('claim-runtime-hint-failure'), undefined);
});

test('failed local open response rolls its advisory claim back', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);

  const response = await handleOpenCommand({
    req: {
      command: 'open',
      token: 'test',
      session: 'claim-response-rollback',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroHost: '10.0.0.10', metroPort: 70_000 },
    },
    sessionName: 'claim-response-rollback',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
  });

  assert.equal(response.ok, false);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
});

test('cancellation after local device setup retains the advisory claim for recovery', async () => {
  const { store, stateDir } = setup();
  const requestId = 'claim-canceled-after-dispatch';
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockResolvedValue({});
  markRequestCanceled(requestId);

  try {
    const response = await handleOpenCommand({
      req: {
        command: 'open',
        token: 'test',
        session: 'claim-canceled-after-dispatch',
        positionals: ['Demo'],
        flags: { platform: 'android' },
        meta: { requestId },
      },
      sessionName: 'claim-canceled-after-dispatch',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
    });

    assert.equal(response.ok, false);
    assert.equal(mockDispatch.mock.calls.length, 1);
    assert.equal(vi.mocked(activateAndroidTestIme).mock.calls.length, 1);
    assert.equal(inspectDeviceClaims({ serial: android.id })[0]?.classification, 'live');
    assert.equal(store.get('claim-canceled-after-dispatch'), undefined);
  } finally {
    clearRequestCanceled(requestId);
  }
});

test('remote open creates no host-local advisory claim', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockResolvedValue({});

  const response = await handleOpenCommand({
    req: {
      command: 'open',
      token: 'test',
      session: 'remote-open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      meta: { leaseProvider: 'proxy', deviceKey: 'android:emulator-5554' },
    },
    sessionName: 'remote-open',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
  });
  assert.equal(response.ok, true);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
  assert.equal(store.get('remote-open')?.deviceClaim, undefined);
});

test('local close clears its matching advisory claim after teardown', async () => {
  const { store, stateDir } = setup();
  const acquired = await acquireAdvisoryDeviceClaim({
    device: android,
    session: 'close-claim',
    workspace: process.cwd(),
    stateDir,
  });
  assert.ok(acquired.ownership);
  store.set('close-claim', {
    name: 'close-claim',
    device: android,
    deviceClaim: acquired.ownership,
    createdAt: Date.now(),
    actions: [],
  });
  mockDispatch.mockResolvedValue({});

  const response = await handleCloseCommand({
    req: { command: 'close', token: 'test', session: 'close-claim', positionals: [], flags: {} },
    sessionName: 'close-claim',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
    leaseRegistry: new LeaseRegistry(),
  });
  assert.equal(response.ok, true);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
});
