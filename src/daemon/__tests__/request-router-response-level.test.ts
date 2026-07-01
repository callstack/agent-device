import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

// Register a test view on a command that flows through the (mocked) generic
// dispatch path, so the router graft mechanics can be exercised end to end
// without the real snapshot handler (the actual snapshot view is unit-tested in
// response-views.test.ts).
vi.mock('../response-views.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../response-views.ts')>();
  return {
    ...actual,
    RESPONSE_VIEWS: {
      ...actual.RESPONSE_VIEWS,
      home: (data: Record<string, unknown>, level: string) =>
        level === 'digest' ? { homeDigest: true, hadItems: Array.isArray(data.items) } : data,
    },
  };
});

import { dispatchCommand } from '../../core/dispatch.ts';
import { createRequestHandler } from '../request-router.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { daemonCommandRequestSchema } from '../../kernel/contracts.ts';

const mockDispatch = vi.mocked(dispatchCommand);

const REPRESENTATIVE_PAYLOAD = { message: 'home-ok', items: [1, 2, 3] } as const;

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
      trackDownloadableArtifact: () => 'artifact-id',
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
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async () => ({ ...REPRESENTATIVE_PAYLOAD }));
});

test('(a) default identity: responseLevel absent === default === no meta, byte-identical', async () => {
  const { handler } = makeHandler();
  const noMeta = await handler(request('home'));
  const emptyMeta = await handler(request('home', { meta: {} }));
  const explicitDefault = await handler(request('home', { meta: { responseLevel: 'default' } }));

  expect(JSON.stringify(noMeta)).toBe(JSON.stringify(emptyMeta));
  expect(JSON.stringify(noMeta)).toBe(JSON.stringify(explicitDefault));
  if (noMeta.ok) expect(noMeta.data).toEqual(REPRESENTATIVE_PAYLOAD);
});

test('(b) digest applies the registered view, dropping the full payload', async () => {
  const { handler } = makeHandler();
  const resp = await handler(request('home', { meta: { responseLevel: 'digest' } }));
  expect(resp.ok).toBe(true);
  if (!resp.ok) return;
  expect(resp.data).toEqual({ homeDigest: true, hadItems: true });
  expect('message' in (resp.data ?? {})).toBe(false);
});

test('(c) full returns today’s shape (view passthrough) — byte-identical to default', async () => {
  const { handler } = makeHandler();
  const full = await handler(request('home', { meta: { responseLevel: 'full' } }));
  const def = await handler(request('home', { meta: { responseLevel: 'default' } }));
  expect(JSON.stringify(full)).toBe(JSON.stringify(def));
});

test('(d) digest composes with --cost: viewed data plus an additive cost block', async () => {
  const { handler } = makeHandler();
  const resp = await handler(
    request('home', { meta: { responseLevel: 'digest', includeCost: true } }),
  );
  expect(resp.ok).toBe(true);
  if (!resp.ok) return;
  expect(resp.data).toMatchObject({ homeDigest: true, hadItems: true });
  expect(typeof resp.data?.cost?.wallClockMs).toBe('number');
});

test('(e) digest on a command with no registered view is byte-identical to default', async () => {
  const { handler } = makeHandler();
  const digest = await handler(request('back', { meta: { responseLevel: 'digest' } }));
  const def = await handler(request('back', { meta: {} }));
  expect(JSON.stringify(digest)).toBe(JSON.stringify(def));
  if (digest.ok) expect(digest.data).toEqual(REPRESENTATIVE_PAYLOAD);
});

test('(f) boundary survival: meta.responseLevel survives daemonCommandRequestSchema parsing', () => {
  const parsed = daemonCommandRequestSchema.parse({
    command: 'snapshot',
    positionals: [],
    meta: { responseLevel: 'digest' },
  });
  expect(parsed.meta?.responseLevel).toBe('digest');

  const parsedOff = daemonCommandRequestSchema.parse({
    command: 'snapshot',
    positionals: [],
    meta: {},
  });
  expect(parsedOff.meta?.responseLevel).toBeUndefined();
});
