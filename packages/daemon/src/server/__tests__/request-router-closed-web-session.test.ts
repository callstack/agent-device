import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  webSessionDevice,
  type DeviceInfo,
  type WebSessionIdentity,
} from '@agent-device/kernel/device';
import { PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';
import {
  WEB_DESKTOP_DEVICE,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { dispatchApplicationLifecycleEffect } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  createLifecycleDeviceRuntimeGatewaySpies,
  createRequestHandler,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { teardownSessionResources } from '../../sessions/session-teardown.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

const webSessionResolution = async (
  _flags: unknown,
  options?: { webSession?: WebSessionIdentity },
): Promise<DeviceInfo> =>
  options?.webSession
    ? webSessionDevice(WEB_DESKTOP_DEVICE, options.webSession)
    : WEB_DESKTOP_DEVICE;

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockImplementation(webSessionResolution);
  dispatchApplicationLifecycleEffect.mockReset();
  dispatchApplicationLifecycleEffect.mockImplementation(async () => undefined);
});

afterEach(() => {
  dispatchApplicationLifecycleEffect.mockReset();
  dispatchApplicationLifecycleEffect.mockImplementation(async () => undefined);
  vi.unstubAllEnvs();
});

function closeEffectCount(): number {
  return dispatchApplicationLifecycleEffect.mock.calls.filter((call) => call[1] === 'close').length;
}

function webDaemon() {
  const claimsDir = mkdtempForTestSync('agent-device-router-closed-web-claims-');
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', claimsDir);
  const sessionStore = makeSessionStore('agent-device-router-closed-web-');
  const platformResourceCleanup = platformResourceCleanupFixture();
  const runtime = createLifecycleDeviceRuntimeGatewaySpies();
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: runtime.gateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    platformResourceCleanup,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return {
    claimsDir,
    sessionStore,
    platformResourceCleanup,
    bind: runtime.bind,
    handler,
  };
}

function request(
  session: string,
  command: string,
  positionals: string[] = [],
  requestId = command,
): DaemonRequest {
  return {
    token: 'test-token',
    session,
    command,
    positionals,
    flags: { platform: 'web' },
    meta: { requestId: `req-${requestId}`, sessionExplicit: true },
  };
}

function closedSessionRefusal(session: string) {
  return {
    ok: false,
    error: {
      code: 'SESSION_NOT_FOUND',
      details: {
        reason: PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound,
        dispatched: 'no',
        session,
      },
    },
  };
}

test('a closed named web session refuses later browser commands and a second close does not close again', async () => {
  const daemon = webDaemon();
  const session = 'closed-web';
  try {
    expect(await daemon.handler(request(session, 'open', ['about:blank']))).toMatchObject({
      ok: true,
    });
    const ref = daemon.sessionStore.lookup(session);
    if (!ref) throw new Error('opened web session is missing');
    expect(await daemon.handler(request(session, 'close'))).toMatchObject({ ok: true });
    expect(daemon.sessionStore.get(session)).toBeUndefined();
    expect(daemon.sessionStore.hasClosedBrowserSession(session)).toBe(true);
    await teardownSessionResources({
      appLog: 'already-settled',
      ref,
      sessionStore: daemon.sessionStore,
      platformCleanup: daemon.platformResourceCleanup,
    });
    expect(daemon.platformResourceCleanup.closeManagedBrowser).not.toHaveBeenCalled();
    const closesAfterFirst = closeEffectCount();
    const managedClosesAfterFirst =
      daemon.platformResourceCleanup.closeManagedBrowser.mock.calls.length;
    expect(closesAfterFirst).toBeGreaterThan(0);
    const bindsAfterClose = daemon.bind.mock.calls.length;

    for (const command of [
      request(session, 'snapshot', [], 'snapshot'),
      request(session, 'screenshot', ['/tmp/closed-web.png'], 'screenshot'),
      request(session, 'click', ['@e1'], 'click'),
    ]) {
      expect(await daemon.handler(command)).toMatchObject(closedSessionRefusal(session));
    }
    expect(daemon.bind.mock.calls.length).toBe(bindsAfterClose);
    expect(closeEffectCount()).toBe(closesAfterFirst);

    expect(await daemon.handler(request(session, 'close', [], 'close-again'))).toMatchObject({
      ok: true,
    });
    expect(closeEffectCount()).toBe(closesAfterFirst);
    expect(daemon.platformResourceCleanup.closeManagedBrowser.mock.calls.length).toBe(
      managedClosesAfterFirst,
    );

    const listed = await daemon.handler(request(session, 'session_list', [], 'list'));
    expect(listed).toMatchObject({ ok: true, data: { sessions: [] } });
  } finally {
    fs.rmSync(daemon.claimsDir, { recursive: true, force: true });
  }
});

test('a failed web close does not stick, and a failed reopen stays closed', async () => {
  const daemon = webDaemon();
  const session = 'reopen-web';
  try {
    expect(await daemon.handler(request(session, 'open', ['about:blank'], 'open-1'))).toMatchObject(
      { ok: true },
    );
    dispatchApplicationLifecycleEffect.mockImplementation(async (_device, command) => {
      if (command === 'close') throw new Error('close failed');
    });
    const failedClose = await daemon.handler(request(session, 'close', [], 'close-fail'));
    expect(failedClose.ok).toBe(false);
    expect(daemon.sessionStore.get(session)).toBeDefined();
    expect(daemon.sessionStore.hasClosedBrowserSession(session)).toBe(false);

    dispatchApplicationLifecycleEffect.mockImplementation(async () => undefined);
    expect(await daemon.handler(request(session, 'close', [], 'close-retry'))).toMatchObject({
      ok: true,
    });
    expect(daemon.sessionStore.hasClosedBrowserSession(session)).toBe(true);

    dispatchApplicationLifecycleEffect.mockImplementation(async (_device, command) => {
      if (command === 'open') throw new Error('open failed');
    });
    const failedOpen = await daemon.handler(request(session, 'open', ['about:blank'], 'open-fail'));
    expect(failedOpen.ok).toBe(false);
    expect(daemon.sessionStore.hasClosedBrowserSession(session)).toBe(true);
    expect(await daemon.handler(request(session, 'snapshot', [], 'snapshot-still'))).toMatchObject(
      closedSessionRefusal(session),
    );

    dispatchApplicationLifecycleEffect.mockImplementation(async () => undefined);
    expect(await daemon.handler(request(session, 'open', ['about:blank'], 'open-2'))).toMatchObject(
      { ok: true },
    );
    expect(daemon.sessionStore.hasClosedBrowserSession(session)).toBe(false);
    expect(daemon.sessionStore.get(session)?.device.platform).toBe('web');
    const reopened = await daemon.handler(request(session, 'snapshot', [], 'snapshot-open'));
    if (!reopened.ok) {
      expect(reopened.error.details?.reason).not.toBe(
        PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound,
      );
    }
  } finally {
    fs.rmSync(daemon.claimsDir, { recursive: true, force: true });
  }
});

test('a named web session that was never opened is not answered as closed', async () => {
  const daemon = webDaemon();
  const session = 'never-opened';
  try {
    const response = await daemon.handler(request(session, 'snapshot'));
    expect(daemon.sessionStore.hasClosedBrowserSession(session)).toBe(false);
    if (!response.ok) {
      expect(response.error.details?.reason).not.toBe(
        PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound,
      );
    }
  } finally {
    fs.rmSync(daemon.claimsDir, { recursive: true, force: true });
  }
});
