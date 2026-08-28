import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { legacyDispatchCapture } from './legacy-snapshot-capture-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return { ...actual, readProcessStartTime: vi.fn(() => 'test-process-start') };
});
// Opening a session runs owned-lease cleanup, which pattern-kills stale xcodebuild runners with a
// real `pkill -f`; the session ids here are fabricated, so stub the tool seam (#1824).
vi.mock('@agent-device/platform-apple/tool-provider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/tool-provider')>();
  return {
    ...actual,
    runAppleToolCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  };
});

import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { awaitFixtureReadiness } from './application-lifecycle-runtime-fixture.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse } from '../types.ts';

/**
 * The production route for the #2031/#1394 defect: a request without `--session` resolves the
 * store key `cwd:<hash>:default`, loads THAT entry, and hands it to a recovery producer whose
 * record is only named `default`. Every recovery below must name the store key, because
 * `--session default` marks the session explicit and therefore addresses a different session.
 *
 * The address is never hand-written here — it is read back from the store the router wrote, so a
 * regression that reverts to `SessionState.name` cannot be papered over by an updated constant.
 */
const SCOPED_ADDRESS_PATTERN = /^cwd:[0-9a-f]{16}:default$/;

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

function makeIosDevice(id: string): DeviceInfo {
  return {
    platform: 'apple',
    id,
    name: `iPhone ${id}`,
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
}

function createHandler(sessionStore: ReturnType<typeof makeSessionStore>) {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

/** A request as the CLI sends it when the caller passed no `--session`: named, but not explicit. */
function implicitRequest(params: {
  command: string;
  cwd: string;
  requestId: string;
  flags?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: params.command,
    positionals: [],
    flags: params.flags ?? {},
    meta: { requestId: params.requestId, cwd: params.cwd, ...params.meta },
  } as DaemonRequest;
}

/** Opens the implicit session and returns the store key the router filed it under. */
async function openImplicitSession(
  handler: ReturnType<typeof createHandler>,
  sessionStore: ReturnType<typeof makeSessionStore>,
  cwd: string,
): Promise<string> {
  const response = await handler(
    implicitRequest({ command: 'open', cwd, requestId: 'req-implicit-open' }),
  );
  expect(response.ok).toBe(true);
  const refs = sessionStore.listRefs();
  expect(refs).toHaveLength(1);
  const address = refs[0]!.address;
  // The defect in one line: the record is named `default`, the store key is not.
  expect(refs[0]!.session.name).toBe('default');
  expect(address).toMatch(SCOPED_ADDRESS_PATTERN);
  return address;
}

function errorHint(response: DaemonResponse): string {
  expect(response.ok).toBe(false);
  if (response.ok) return '';
  return String(response.error.hint ?? '');
}

function expectAddressableRecovery(hint: string, address: string): void {
  expect(hint).toContain(`--session ${address}`);
  expect(hint).not.toMatch(/--session default\b/);
}

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
});

test('device-in-use against an implicit session names its store key, not "default"', async () => {
  const sessionStore = makeSessionStore('agent-device-router-address-');
  const cwd = mkdtempForTestSync('agent-device-scope-');
  const device = makeIosDevice('SIM-IN-USE');
  mockResolveTargetDevice.mockResolvedValue(device);
  const handler = createHandler(sessionStore);
  const address = await openImplicitSession(handler, sessionStore, cwd);

  const response = await handler({
    token: 'test-token',
    session: 'checkout',
    command: 'open',
    positionals: [],
    flags: { platform: 'ios' },
    meta: { requestId: 'req-explicit-open', cwd, sessionExplicit: true },
  } as DaemonRequest);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('DEVICE_IN_USE');
  expect(response.error.message).toContain(`session "${address}"`);
  expect(response.error.details?.session).toBe(address);
  expectAddressableRecovery(errorHint(response), address);
  expect(errorHint(response)).toContain(`agent-device close --session ${address}`);
});

test('selector conflict on an implicit session names its store key, not "default"', async () => {
  const sessionStore = makeSessionStore('agent-device-router-address-');
  const cwd = mkdtempForTestSync('agent-device-scope-');
  mockResolveTargetDevice.mockResolvedValue(makeIosDevice('SIM-BOUND'));
  const handler = createHandler(sessionStore);
  const address = await openImplicitSession(handler, sessionStore, cwd);

  const response = await handler(
    implicitRequest({
      command: 'home',
      cwd,
      requestId: 'req-selector-conflict',
      flags: { udid: 'SIM-OTHER' },
    }),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toContain(`Session "${address}"`);
  expectAddressableRecovery(errorHint(response), address);
});

test('lock-policy conflict on an implicit session names its store key, not "default"', async () => {
  const sessionStore = makeSessionStore('agent-device-router-address-');
  const cwd = mkdtempForTestSync('agent-device-scope-');
  mockResolveTargetDevice.mockResolvedValue(makeIosDevice('SIM-LOCKED'));
  const handler = createHandler(sessionStore);
  const address = await openImplicitSession(handler, sessionStore, cwd);

  const response = await handler(
    implicitRequest({
      command: 'home',
      cwd,
      requestId: 'req-lock-conflict',
      flags: { udid: 'SIM-OTHER' },
      meta: { lockPolicy: 'reject' },
    }),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toContain(`session "${address}"`);
  expect(response.error.details?.session).toBe(address);
  expectAddressableRecovery(errorHint(response), address);
});

test('session list reports the address an implicit session answers to alongside its name', async () => {
  const sessionStore = makeSessionStore('agent-device-router-address-');
  const cwd = mkdtempForTestSync('agent-device-scope-');
  mockResolveTargetDevice.mockResolvedValue(makeIosDevice('SIM-LISTED'));
  const handler = createHandler(sessionStore);
  const address = await openImplicitSession(handler, sessionStore, cwd);

  const response = await handler(
    implicitRequest({ command: 'session_list', cwd, requestId: 'req-session-list' }),
  );

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const sessions = response.data?.sessions as { name: string; address: string }[] | undefined;
  expect(sessions).toHaveLength(1);
  expect(sessions?.[0]?.name).toBe('default');
  expect(sessions?.[0]?.address).toBe(address);
  expect(sessions?.[0]?.address).toMatch(SCOPED_ADDRESS_PATTERN);
});
