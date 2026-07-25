import { beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

vi.mock('../runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-hints.ts')>();
  return { ...actual, applyRuntimeHintsToApp: vi.fn(async () => {}) };
});

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, prewarmIosRunnerSession: vi.fn() };
});

vi.mock('../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/apps.ts')>();
  return { ...actual, resolveIosApp: vi.fn(async () => 'com.example.app') };
});

vi.mock('../handlers/session-device-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/session-device-utils.ts')>();
  return { ...actual, settleIosSimulator: vi.fn(async () => {}) };
});

import { dispatchCommand } from '../../core/dispatch.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from '../request-router.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);
});

test('replay runs active-session actions inside the parent request provider scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-scope-'));
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'home\nback\n');
  const sessionStore = makeSessionStore('agent-device-replay-scope-');
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const appleRunnerProvider = vi.fn(() => undefined);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-full-route-'));
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'runtime set --platform ios --metro-host localhost\nhome\n');
  const sessionStore = makeSessionStore('agent-device-replay-full-route-');
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const appleRunnerProvider = vi.fn(() => undefined);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-open-scope-'));
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "com.example.app"\n');
  const sessionStore = makeSessionStore('agent-device-replay-open-scope-');

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    appleRunnerProvider: () => undefined,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const replayResponse = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [replayPath],
    flags: { platform: 'ios' },
    meta: { cwd: root, requestId: 'replay-open-scope' },
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
