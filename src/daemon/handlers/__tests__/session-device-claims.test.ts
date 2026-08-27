import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch-resolve.ts')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../__tests__/device-selection-stub.ts');
  const resolveTargetDevice = vi.fn();
  return {
    ...actual,
    resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(resolveTargetDevice)),
  };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platform-runtime-runtime-hints.ts')>();
  return { ...actual, applyRuntimeHintValues: vi.fn(async () => {}) };
});
vi.mock('../../../platform-runtime-open-target.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform-runtime-open-target.ts')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn() };
});
vi.mock('../../../platforms/android/ime-lifecycle.ts', () => ({
  activateAndroidTestIme: vi.fn(async () => ({ activated: false })),
  restoreAndroidTestIme: vi.fn(async () => ({ restored: false, reason: 'no-record' })),
}));
vi.mock('../../../utils/host-process.ts', async (importOriginal) =>
  (await import('../../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

import { resolveTargetDevice } from '../../../core/dispatch-resolve.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import { applyRuntimeHintValues } from '../../../platform-runtime-runtime-hints.ts';
import { resolveAndroidPackageForOpen } from '../../../platform-runtime-open-target.ts';
import { activateAndroidTestIme } from '../../../platforms/android/ime-lifecycle.ts';
import {
  discoverReadyAndroidEmulators,
  dispatchApplicationLifecycleEffect,
} from '../../__tests__/application-lifecycle-runtime-fixture.ts';
import { clearRequestCanceled, markRequestCanceled } from '../../../request/cancel.ts';
import { acquireDeviceClaim as acquireProductionDeviceClaim } from '../../device-claims.ts';
import { inspectDeviceClaims } from '../../device-claim-inspection.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { SessionStore } from '../../session-store.ts';
import { handleCloseCommand as handleProductionCloseCommand } from '../session-close.ts';
import { handleOpenCommand as handleProductionOpenCommand } from '../session-open.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeAuthoringSession } from '../../../__tests__/test-utils/session-factories.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  bindProviderLifecycleRuntime,
  bindLifecycleRuntime,
  inspectProviderLifecycleRuntimeFacts,
  inspectLifecycleRuntimeFacts,
} from './application-lifecycle-runtime-harness.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockDiscoverReadyAndroidEmulators = vi.mocked(discoverReadyAndroidEmulators);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockApplyRuntimeHints = vi.mocked(applyRuntimeHintValues);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const roots: string[] = [];
const reconcileOrphanedDeviceClaim = async () => ({
  status: 'retained' as const,
  reason: 'test-no-recovery',
});

function handleOpenCommand(
  params: Omit<Parameters<typeof handleProductionOpenCommand>[0], 'reconcileOrphanedDeviceClaim'>,
) {
  return handleProductionOpenCommand({
    ...params,
    inspectFacts: params.inspectFacts ?? inspectLifecycleRuntimeFacts,
    bindDevice: params.bindDevice ?? bindLifecycleRuntime,
    reconcileOrphanedDeviceClaim,
  });
}

function handleCloseCommand(
  params: Omit<Parameters<typeof handleProductionCloseCommand>[0], 'inspectFacts' | 'bindDevice'>,
) {
  return handleProductionCloseCommand({
    ...params,
    platformResourceCleanup,
    inspectFacts: inspectLifecycleRuntimeFacts,
    bindDevice: bindLifecycleRuntime,
  });
}

function acquireDeviceClaim(
  params: Omit<Parameters<typeof acquireProductionDeviceClaim>[0], 'reconcileOrphanedDeviceClaim'>,
) {
  return acquireProductionDeviceClaim({ ...params, reconcileOrphanedDeviceClaim });
}

afterEach(() => {
  vi.clearAllMocks();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockApplyRuntimeHints.mockResolvedValue(undefined);
  mockResolveAndroidPackage.mockResolvedValue(undefined);
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): { store: SessionStore; stateDir: string } {
  const stateDir = mkdtempForTestSync('agent-device-session-device-claim-');
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

test('failed local open before device setup rolls its device claim back', async () => {
  const { store, stateDir } = setup();
  // A stopped AVD, so preparation actually runs emulator discovery. Readiness is package-owned
  // now, so this is where a pre-device-effect failure surfaces.
  const stoppedAvd = { ...android, id: 'pixel-avd', booted: false };
  mockResolveTargetDevice.mockResolvedValue(stoppedAvd);
  // The point of this test is claim-rollback behavior around an opaque pre-device-effect
  // failure, not any particular error shape, so assert identity of the propagated error.
  const rejectionError = new Error('device not ready');
  mockDiscoverReadyAndroidEmulators.mockRejectedValue(rejectionError);

  await assert.rejects(
    async () =>
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
    (error: unknown) => error === rejectionError,
  );
  assert.deepEqual(inspectDeviceClaims({ serial: stoppedAvd.id }), []);
});

test('failed local open after dispatch retains its device claim for recovery', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  // The point of this test is claim-retention behavior around an opaque post-dispatch
  // failure, not any particular error shape, so assert identity of the propagated error.
  const rejectionError = new Error('open failed');
  mockDispatch.mockRejectedValue(rejectionError);

  await assert.rejects(
    async () =>
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
    (error: unknown) => error === rejectionError,
  );
  assert.equal(inspectDeviceClaims({ serial: android.id })[0]?.classification, 'live');
});

test('failed local runtime-hint setup retains its device claim before open dispatch', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockResolveAndroidPackage.mockResolvedValue('com.example.demo');
  // The point of this test is claim-retention behavior around an opaque pre-dispatch
  // failure, not any particular error shape, so assert identity of the propagated error.
  const rejectionError = new Error('runtime hints changed before failure');
  mockApplyRuntimeHints.mockRejectedValue(rejectionError);

  await assert.rejects(
    async () =>
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
    (error: unknown) => error === rejectionError,
  );

  assert.equal(mockApplyRuntimeHints.mock.calls.length, 1);
  assert.equal(mockDispatch.mock.calls.length, 0);
  assert.equal(inspectDeviceClaims({ serial: android.id })[0]?.classification, 'live');
  assert.equal(store.get('claim-runtime-hint-failure'), undefined);
});

test('failed local open response rolls its device claim back', async () => {
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

test('cancellation after local device setup retains the device claim for recovery', async () => {
  const { store, stateDir } = setup();
  const requestId = 'claim-canceled-after-dispatch';
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockResolvedValue(undefined);
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

test('provider-owned open creates no host-local device claim from its selected owner', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockResolvedValue(undefined);

  const response = await handleOpenCommand({
    req: {
      command: 'open',
      token: 'test',
      session: 'remote-open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      // Ambient request metadata is intentionally irrelevant. The admitted binding below is the
      // sole owner authority and must not reach through to local ADB or claim bookkeeping.
      meta: { leaseProvider: 'unrelated-ambient-provider', deviceKey: 'android:emulator-5554' },
    },
    sessionName: 'remote-open',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
    inspectFacts: inspectProviderLifecycleRuntimeFacts,
    bindDevice: bindProviderLifecycleRuntime,
  });
  assert.equal(response.ok, true);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
  assert.equal(store.get('remote-open')?.deviceClaim, undefined);
});

test('a foreign live claim rejects open before platform preparation or mutation', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  const ownerStateDir = path.join(stateDir, 'foreign-owner');
  fs.mkdirSync(ownerStateDir);
  const acquired = await acquireDeviceClaim({
    device: android,
    session: 'foreign-session',
    workspace: '/worktrees/foreign',
    stateDir: ownerStateDir,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;

  const response = await handleOpenCommand({
    req: {
      command: 'open',
      token: 'test',
      session: 'second-session',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      meta: { cwd: '/worktrees/second' },
    },
    sessionName: 'second-session',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
  });

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'DEVICE_IN_USE');
  assert.equal(response.error.retriable, false);
  assert.equal(response.error.details?.reason, 'DEVICE_CLAIM_LIVE_OWNER');
  assert.deepEqual(response.error.details?.owner, {
    session: 'foreign-session',
    workspace: '/worktrees/foreign',
    stateDir: ownerStateDir,
  });
  assert.deepEqual(response.error.details?.recovery, {
    command: 'agent-device device status --platform android --serial emulator-5554',
  });
  assert.equal(mockEnsureDeviceReady.mock.calls.length, 0);
  assert.equal(mockResolveAndroidPackage.mock.calls.length, 0);
  assert.equal(mockApplyRuntimeHints.mock.calls.length, 0);
  assert.equal(vi.mocked(activateAndroidTestIme).mock.calls.length, 0);
  assert.equal(mockDispatch.mock.calls.length, 0);
  assert.equal(store.get('second-session'), undefined);
});

test('local close clears its matching device claim after teardown', async () => {
  const { store, stateDir } = setup();
  const acquired = await acquireDeviceClaim({
    device: android,
    session: 'close-claim',
    workspace: process.cwd(),
    stateDir,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  store.set('close-claim', {
    name: 'close-claim',
    device: android,
    deviceClaim: acquired.ownership,
    createdAt: Date.now(),
    actions: [],
  });
  mockDispatch.mockResolvedValue(undefined);

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

test('#1391: a close-time script save failure still clears the device claim and deletes the session', async () => {
  const { store, stateDir } = setup();
  const acquired = await acquireDeviceClaim({
    device: android,
    session: 'close-save-script-failure',
    workspace: process.cwd(),
    stateDir,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  const targetPath = path.join(stateDir, 'already-published.ad');
  fs.writeFileSync(targetPath, 'pre-existing\n');
  // Retained directly (not just looked up via `store`) so it stays inspectable
  // after `handleCloseCommand` deletes it from the store — `store.delete` only
  // drops the map entry, it doesn't touch the object this variable still
  // points at.
  const session = makeAuthoringSession('close-save-script-failure', {
    device: android,
    deviceClaim: acquired.ownership,
    scriptPublication: {
      kind: 'authoring',
      status: 'armed',
      target: { kind: 'explicit', path: targetPath, force: false },
    },
  });
  store.set('close-save-script-failure', session);
  mockDispatch.mockResolvedValue(undefined);

  // Like the platform-close-error tests above, a failed close-time save is
  // thrown (not returned as `{ok:false}`) — `handleCloseCommand` never
  // converts its own errors; the request-router does that for real requests.
  let thrown: unknown;
  try {
    await handleCloseCommand({
      req: {
        command: 'close',
        token: 'test',
        session: 'close-save-script-failure',
        positionals: [],
        flags: {},
      },
      sessionName: 'close-save-script-failure',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
      leaseRegistry: new LeaseRegistry(),
    });
  } catch (error) {
    thrown = error;
  }

  // The failed save is surfaced, but never at the cost of leaking the session
  // or the device claim (#1391 item 1) — and the target is left untouched
  // rather than rewritten (#1391 item 2).
  assert.ok(thrown instanceof AppError, 'expected close to throw an AppError');
  const error = thrown as AppError;
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.match(error.message, /session was closed, but its script was not saved/);
  assert.equal(error.details?.retriable, false);
  // The original write failure's machine-readable details survive the
  // close-specific hint/retriable override, so a caller dispatching on them
  // (e.g. `reason === 'script_target_exists'`) still can.
  assert.equal(error.details?.reason, 'script_target_exists');
  assert.equal(error.details?.path, targetPath);
  assert.equal(store.get('close-save-script-failure'), undefined);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'pre-existing\n');

  assert.deepEqual(
    session.actions.map((action) => action.command),
    ['close'],
  );
  await store.flushEvents('close-save-script-failure');
  const durableCloseEvents = store
    .readEvents('close-save-script-failure')
    .events.filter((event) => event.kind === 'action.recorded' && event.command === 'close');
  assert.equal(durableCloseEvents.length, session.actions.length);
});
