import { refFrame } from '../../../core/ref-frame.ts';
import { SessionStore } from '../../../core/session-store.ts';
import path from 'node:path';
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { clearDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { lifecycleOperationsSpy } from '../../../__tests__/support/lifecycle-operations-spy.ts';
import { handleSessionCommands } from '../../../__tests__/support/handlers/session-command-harness.ts';
import { noopInvoke } from './__tests__/session-open-runtime.fixtures.ts';
import { beginOpenDeviceWait, readOpenWaitBudgetMs } from '../../open-device-contention-wait.ts';
const { mockResolveTargetDevice } = vi.hoisted(() => ({ mockResolveTargetDevice: vi.fn() }));
vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../__tests__/support/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});
bindTestCommandHost();
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
const openApplication = vi.fn(async (_input: OpenApplicationInput) => ({ timing: {} }));
const prepareApplicationOpen = vi.fn(async () => {});
const { loader } = lifecycleOperationsSpy({
  openApplication,
  prepareApplicationOpen,
  resolveOpenTarget: async (input) => ({
    appBundleId: input.target?.includes('://') ? undefined : input.target,
    appName: input.target,
  }),
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function makeSessionStore(backend = 'native') {
  const root = mkdtempForTestSync('macos-open-claims');
  return new SessionStore(
    path.join(root, 'sessions'),
    createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_MACOS_APP_BACKEND: backend,
        AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
      },
    }),
  );
}
const HOST_MAC = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
} as const;

function nativeMacOpener(sessionStore: ReturnType<typeof makeSessionStore>) {
  mockResolveTargetDevice.mockResolvedValue(HOST_MAC);
  return async (session: string, positionals: string[], extra: Partial<DaemonRequest> = {}) =>
    await handleSessionCommands({
      host: sessionStore.host,
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      lifecycleOperationsLoader: loader,
      req: {
        token: 't',
        session,
        command: 'open',
        positionals,
        flags: { platform: 'macos' },
        ...extra,
      },
      sessionName: session,
      logPath: path.join(mkdtempForTestSync('agent-device-macos-app-claim-'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });
}

function restoreMacOpener(): void {
  vi.unstubAllEnvs();
}

function lastOpenWasBackground(): boolean {
  const context = openApplication.mock.calls.at(-1)?.[0] as { background?: boolean } | undefined;
  return context?.background === true;
}

test('native macOS app sessions claim their app, so another app opens beside them', async () => {
  const sessionStore = makeSessionStore();
  const open = nativeMacOpener(sessionStore);
  const refusedFor = { ok: false, error: { details: { reason: 'app-claim-scope' } } };

  expect(await open('one', ['com.example.one'])).toMatchObject({ ok: true });
  expect(lastOpenWasBackground()).toBe(true);
  expect(await open('two', ['com.example.two'])).toMatchObject({ ok: true });
  expect(await open('three', ['com.example.one'])).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE' },
  });
  expect(await open('one', ['com.example.two'])).toMatchObject(refusedFor);
  expect(await open('one', ['demo://route'])).toMatchObject(refusedFor);
  expect(await open('one', ['com.example.one'])).toMatchObject({ ok: true });
  expect(lastOpenWasBackground()).toBe(true);

  restoreMacOpener();
});

test('a macos-app lease session and an app session of the same bundle conflict in both orders', async () => {
  const lease = (bundleId: string) => ({
    leaseId: `lease-${bundleId}`,
    tenantId: 'tenant',
    runId: 'run',
    backend: 'macos-app' as const,
    deviceKey: bundleId,
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const leasedOpen = (bundleId: string): Partial<DaemonRequest> => ({
    internal: { admittedLease: lease(bundleId) },
  });
  const inUse = { ok: false, error: { code: 'DEVICE_IN_USE' } };

  const leaseFirst = makeSessionStore();
  const openBesideLease = nativeMacOpener(leaseFirst);
  expect(
    await openBesideLease('leased', ['com.example.one'], leasedOpen('com.example.one')),
  ).toMatchObject({ ok: true });
  expect(lastOpenWasBackground()).toBe(true);
  expect(await openBesideLease('app', ['com.example.one'])).toMatchObject(inUse);
  expect(await openBesideLease('other', ['com.example.two'])).toMatchObject({ ok: true });

  const appFirst = makeSessionStore();
  const openBesideApp = nativeMacOpener(appFirst);
  expect(await openBesideApp('app', ['com.example.one'])).toMatchObject({ ok: true });
  expect(
    await openBesideApp('leased', ['com.example.one'], leasedOpen('com.example.one')),
  ).toMatchObject(inUse);
  expect(
    await openBesideApp('leased-two', ['com.example.two'], leasedOpen('com.example.two')),
  ).toMatchObject({ ok: true });

  restoreMacOpener();
});

test('a macOS app session that holds the whole Mac opens its app in front', async () => {
  const sessionStore = makeSessionStore('xctest');
  const open = nativeMacOpener(sessionStore);

  expect(await open('xctest', ['com.example.one'])).toMatchObject({ ok: true });
  expect(sessionStore.get('xctest')?.deviceClaim?.app).toBeUndefined();
  expect(lastOpenWasBackground()).toBe(false);

  restoreMacOpener();
});

test('a whole-Mac open with a wait budget waits beside an app session and opens once it retires', async () => {
  const sessionStore = makeSessionStore();
  const open = nativeMacOpener(sessionStore);
  expect(await open('one', ['com.example.one'])).toMatchObject({ ok: true });
  const dispatchesBeforeWait = openApplication.mock.calls.length;

  const req: DaemonRequest = {
    token: 't',
    session: 'whole',
    command: 'open',
    positionals: [],
    flags: { platform: 'macos', waitMs: 5_000 },
    meta: { requestId: 'req-whole-wait' },
  };
  const wait = beginOpenDeviceWait({
    req,
    budgetMs: readOpenWaitBudgetMs(req),
    sessionName: 'whole',
    sessionStore,
    deviceId: HOST_MAC.id,
  })!;
  const holder = sessionStore.lookup('one')!;
  setTimeout(async () => {
    await clearDeviceClaim(holder.session.deviceClaim, sessionStore.host.env);
    sessionStore.retire(holder);
  }, 300);

  const startedAtMs = Date.now();
  const response = await wait.runWhenDeviceIsUnheld({
    acquireLocks: async (task) => await task(),
    task: async () =>
      await open('whole', [], { flags: req.flags, internal: req.internal, meta: req.meta }),
  });

  expect(response).toMatchObject({ ok: true });
  expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(250);
  expect(openApplication.mock.calls.length).toBe(dispatchesBeforeWait + 1);
  expect(sessionStore.get('whole')?.deviceClaim?.app).toBeUndefined();

  restoreMacOpener();
});

test('a rejected cross-app reopen preserves the current frame and skips preparation', async () => {
  const store = makeSessionStore();
  const open = nativeMacOpener(store);
  expect(await open('one', ['com.example.one'])).toMatchObject({ ok: true });
  const session = store.get('one')!;
  const frame = refFrame(session);
  prepareApplicationOpen.mockClear();
  expect(await open('one', ['com.example.two'])).toMatchObject({
    ok: false,
    error: { details: { reason: 'app-claim-scope' } },
  });
  expect(prepareApplicationOpen).not.toHaveBeenCalled();
  expect(refFrame(session)).toBe(frame);
});
