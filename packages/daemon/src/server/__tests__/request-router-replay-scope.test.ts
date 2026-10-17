import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';

import path from 'node:path';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';
const testCreateCommandSurface = createTouchCommandSurface();
import type {
  PlatformProviderRequestContext,
  RequestPlatformProviderScope,
  RequestPlatformProviders,
} from '@agent-device/contracts/platform-providers';

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, prewarmIosRunnerSession: vi.fn() };
});

vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async () => 'com.example.app'),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});

import {
  IOS_SIMULATOR,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  createRequestHandler,
  gestureRuntimeSpies,
  lifecycleDeviceRuntimeGateway,
  systemRuntimeSpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
// Readiness is package-owned; hold the open at the fixture's platform-neutral readiness gate.
import { awaitFixtureReadiness } from '../../__tests__/support/application-lifecycle-runtime-fixture.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

beforeEach(() => {
  gestureRuntimeSpies.scrollDirection.mockClear();
  systemRuntimeSpies.appSwitcher.mockClear();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
});

test('replay runs active-session actions inside the parent request provider scope', async () => {
  const root = mkdtempForTestSync('agent-device-replay-scope-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'app-switcher\nscroll down\n');
  const sessionStore = makeSessionStore('agent-device-replay-scope-');
  sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const providerScopes = requestPlatformProvidersFake();

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    requestPlatformProviders: providerScopes.providers,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    meta: { cwd: root, requestId: 'replay-scope-1', sessionExplicit: true },
  });

  expect(response).toMatchObject({ ok: true });
  // Both actions now reach bound operations — `app-switcher` through R56, `scroll down` through
  // R53 — so the flow drives the runtime gateway twice and the legacy dispatcher not at all.
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(systemRuntimeSpies.appSwitcher).toHaveBeenCalledTimes(1);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
  expect(providerScopes.contexts).toHaveLength(1);
  expect(providerScopes.contexts[0]).toMatchObject({
    requestId: 'replay-scope-1',
    session: { name: 'default', device: { platform: 'apple' } },
  });
});

test('replay routes session-changing actions through the full request path', async () => {
  const root = mkdtempForTestSync('agent-device-replay-full-route-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'runtime set --platform ios --metro-host localhost\napp-switcher\n');
  const sessionStore = makeSessionStore('agent-device-replay-full-route-');
  sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const providerScopes = requestPlatformProvidersFake();

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    requestPlatformProviders: providerScopes.providers,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    meta: { cwd: root, requestId: 'replay-scope-2', sessionExplicit: true },
  });

  expect(response).toMatchObject({ ok: true });
  // `app-switcher` reaches its bound operation since R56; `runtime set` mutates session state and
  // never dispatched, so the legacy dispatcher sees neither action.
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(systemRuntimeSpies.appSwitcher).toHaveBeenCalledTimes(1);
  expect(providerScopes.contexts).toHaveLength(2);
  expect(providerScopes.contexts.every((context) => context.session?.name === 'default')).toBe(
    true,
  );
});

test('session list includes a cwd-scoped session opened by replay', async () => {
  const root = mkdtempForTestSync('agent-device-replay-open-scope-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "com.example.app"\n');
  const sessionStore = makeSessionStore('agent-device-replay-open-scope-');

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const replayResponse = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    flags: { platform: 'ios' },
    meta: { cwd: root, requestId: 'replay-open-scope', deviceKey: 'test:sim-1' },
  });
  expect(replayResponse).toMatchObject({ ok: true });
  const listResponse = await handler({
    token: 'test-token',
    session: 'default',
    command: 'session_list',
    positionals: [],
    meta: { cwd: root, requestId: 'session-list-scope' },
  });

  expect(listResponse).toMatchObject({
    ok: true,
    data: {
      sessions: [
        expect.objectContaining({
          // A platform-selecting request addresses that platform's own implicit session (#2580).
          name: expect.stringMatching(/^cwd:[a-f0-9]+:ios$/),
        }),
      ],
    },
  });
});

test('fresh replay retains a dynamically selected device through finalization', async () => {
  const root = mkdtempForTestSync('agent-device-replay-device-lock-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform ios --metro-host localhost\nopen "demo://checkout"\n',
  );
  const sessionStore = makeSessionStore('agent-device-replay-device-lock-');
  const leaseRegistry = new LeaseRegistry();
  let releaseReadiness: () => void = () => {};
  const readinessReleased = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  let markReadinessEntered: () => void = () => {};
  const readinessEntered = new Promise<void>((resolve) => {
    markReadinessEntered = resolve;
  });
  mockAwaitFixtureReadiness.mockImplementation(async () => {
    markReadinessEntered();
    await readinessReleased;
  });

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const replayResponse = handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    flags: { platform: 'ios' },
    meta: { cwd: root, requestId: 'replay-device-lock', deviceKey: 'test:sim-1' },
  });
  await readinessEntered;

  sessionStore.publish('external', makeIosSession('external'));
  let externalRequestSettled = false;
  const externalResponse = handler({
    token: 'test-token',
    session: 'external',
    command: 'home',
    positionals: [],
    meta: {
      cwd: root,
      requestId: 'external-device-command',
      sessionExplicit: true,
    },
  }).finally(() => {
    externalRequestSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(externalRequestSettled).toBe(false);

  releaseReadiness();
  await expect(replayResponse).resolves.toMatchObject({ ok: true });
  await externalResponse;
  expect(externalRequestSettled).toBe(true);
});

function requestPlatformProvidersFake(): {
  providers: RequestPlatformProviders;
  contexts: PlatformProviderRequestContext[];
} {
  const contexts: PlatformProviderRequestContext[] = [];
  return {
    contexts,
    providers: {
      hasConfiguredResolvers: true,
      async run(context, task) {
        contexts.push(context);
        return await task({} satisfies RequestPlatformProviderScope);
      },
    },
  };
}
