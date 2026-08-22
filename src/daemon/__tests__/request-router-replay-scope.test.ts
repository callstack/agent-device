import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

vi.mock('../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform-runtime-runtime-hints.ts')>();
  return { ...actual, applyRuntimeHintValues: vi.fn(async () => {}) };
});

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, prewarmIosRunnerSession: vi.fn() };
});

vi.mock('../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/apps.ts')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async () => 'com.example.app'),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});

import { dispatchCommand } from '../../core/dispatch.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';
import { ensureDeviceReady } from '../device-ready.ts';
// Readiness is package-owned; hold the open at the fixture's platform-neutral readiness gate.
import { awaitFixtureReadiness } from './application-lifecycle-runtime-fixture.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue();
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
});

test('replay runs active-session actions inside the parent request provider scope', async () => {
  const root = mkdtempForTestSync('agent-device-replay-scope-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'app-switcher\nscroll down\n');
  const sessionStore = makeSessionStore('agent-device-replay-scope-');
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const appleRunnerProvider = vi.fn(() => undefined);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    appleRunnerProvider,
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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(appleRunnerProvider).toHaveBeenCalledTimes(1);
});

test('replay routes session-changing actions through the full request path', async () => {
  const root = mkdtempForTestSync('agent-device-replay-full-route-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'runtime set --platform ios --metro-host localhost\napp-switcher\n');
  const sessionStore = makeSessionStore('agent-device-replay-full-route-');
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const appleRunnerProvider = vi.fn(() => undefined);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    appleRunnerProvider,
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
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(appleRunnerProvider).toHaveBeenCalledTimes(2);
});

test('session list includes a cwd-scoped session opened by replay', async () => {
  const root = mkdtempForTestSync('agent-device-replay-open-scope-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "com.example.app"\n');
  const sessionStore = makeSessionStore('agent-device-replay-open-scope-');

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    appleRunnerProvider: () => undefined,
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
          name: expect.stringMatching(/^cwd:[a-f0-9]+:default$/),
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
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    appleRunnerProvider: () => undefined,
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

  sessionStore.set('external', makeIosSession('external'));
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
