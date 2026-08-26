import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../platforms/apple/core/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

// Register a test view on a command whose payload this file controls end to end, so the router
// graft mechanics can be exercised without the real snapshot handler (the actual snapshot view is
// unit-tested in response-views.test.ts). `app-switcher` reaches a bound operation since R56, so
// its payload is the one the daemon leaf builds rather than a mocked dispatcher's.
vi.mock('../response-views.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../response-views.ts')>();
  return {
    ...actual,
    RESPONSE_VIEWS: {
      ...actual.RESPONSE_VIEWS,
      'app-switcher': (data: Record<string, unknown>, level: string) =>
        level === 'digest'
          ? { appSwitcherDigest: true, hadAction: data.action === 'app-switcher' }
          : data,
    },
  };
});

import {
  createRequestHandler,
  gestureRuntimeSpies,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { commandRpcParamsSchema } from '@agent-device/kernel/contracts';

const REPRESENTATIVE_PAYLOAD = { message: 'scroll-ok', items: [1, 2, 3] } as const;
/** What the bound `app-switcher` leaf answers; this file's registered view digests it. */
const APP_SWITCHER_PAYLOAD = { action: 'app-switcher', message: 'Opened app switcher' } as const;

function makeIosSession(name: string): SessionState {
  return {
    name,
    createdAt: 1_700_000_000_000,
    actions: [],
    device: {
      platform: 'apple',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/set',
    },
  };
}

function makeHandler() {
  const sessionStore = makeSessionStore('agent-device-router-level-');
  sessionStore.set('level-session', makeIosSession('level-session'));
  return {
    sessionStore,
    handler: createRequestHandler({
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
      // Both subjects reach bound runtimes now — `app-switcher` through R56 and `scroll` through
      // R53 — so the handler needs an owner admitting `appSwitcher` and `scrollDirection` alike.
      deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    }),
  };
}

function request(command: string, overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'level-session',
    command,
    positionals: [],
    flags: {},
    ...overrides,
  };
}

beforeEach(() => {
  gestureRuntimeSpies.scrollDirection.mockReset();
  gestureRuntimeSpies.scrollDirection.mockResolvedValue({});
});

test('(a) default identity: responseLevel absent === default === no meta, byte-identical', async () => {
  const { handler } = makeHandler();
  const noMeta = await handler(request('app-switcher'));
  const emptyMeta = await handler(request('app-switcher', { meta: {} }));
  const explicitDefault = await handler(
    request('app-switcher', { meta: { responseLevel: 'default' } }),
  );

  expect(JSON.stringify(noMeta)).toBe(JSON.stringify(emptyMeta));
  expect(JSON.stringify(noMeta)).toBe(JSON.stringify(explicitDefault));
  if (noMeta.ok) expect(noMeta.data).toEqual(APP_SWITCHER_PAYLOAD);
});

test('(b) digest applies the registered view, dropping the full payload', async () => {
  const { handler } = makeHandler();
  const resp = await handler(request('app-switcher', { meta: { responseLevel: 'digest' } }));
  expect(resp.ok).toBe(true);
  if (!resp.ok) return;
  expect(resp.data).toEqual({ appSwitcherDigest: true, hadAction: true });
  expect('message' in (resp.data ?? {})).toBe(false);
});

test('(c) full returns today’s shape (view passthrough) — byte-identical to default', async () => {
  const { handler } = makeHandler();
  const full = await handler(request('app-switcher', { meta: { responseLevel: 'full' } }));
  const def = await handler(request('app-switcher', { meta: { responseLevel: 'default' } }));
  expect(JSON.stringify(full)).toBe(JSON.stringify(def));
});

test('(d) digest composes with --cost: viewed data plus an additive cost block', async () => {
  const { handler } = makeHandler();
  const resp = await handler(
    request('app-switcher', { meta: { responseLevel: 'digest', includeCost: true } }),
  );
  expect(resp.ok).toBe(true);
  if (!resp.ok) return;
  expect(resp.data).toMatchObject({ appSwitcherDigest: true, hadAction: true });
  expect(typeof resp.data?.cost?.wallClockMs).toBe('number');
});

test('(e) digest on a command with no registered view is byte-identical to default', async () => {
  const { handler } = makeHandler();
  // `scroll` has no registered view. It no longer reaches the mocked `dispatchCommand` (R53 put
  // it on a bound runtime), so the representative payload comes from the bound operation instead.
  gestureRuntimeSpies.scrollDirection.mockResolvedValue({ ...REPRESENTATIVE_PAYLOAD });
  const scrollRequest: Partial<DaemonRequest> = { positionals: ['down'], meta: {} };
  const digest = await handler(
    request('scroll', { ...scrollRequest, meta: { responseLevel: 'digest' } }),
  );
  const def = await handler(request('scroll', scrollRequest));
  expect(JSON.stringify(digest)).toBe(JSON.stringify(def));
  // The owner's payload passes through the view-less path; scroll's own result fields sit beside
  // it, and its success text owns `message`.
  if (digest.ok) {
    expect(digest.data).toMatchObject({ items: REPRESENTATIVE_PAYLOAD.items, direction: 'down' });
  }
});

test('(f) boundary survival: meta.responseLevel survives commandRpcParamsSchema parsing', () => {
  const parsed = commandRpcParamsSchema.parse({
    command: 'snapshot',
    positionals: [],
    meta: { responseLevel: 'digest' },
  });
  expect(parsed.meta?.responseLevel).toBe('digest');

  const parsedOff = commandRpcParamsSchema.parse({
    command: 'snapshot',
    positionals: [],
    meta: {},
  });
  expect(parsedOff.meta?.responseLevel).toBeUndefined();
});
