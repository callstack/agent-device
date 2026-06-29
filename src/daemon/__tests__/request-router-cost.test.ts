import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../platforms/ios/runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/ios/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { dispatchCommand } from '../../core/dispatch.ts';
import { createRequestHandler } from '../request-router.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { daemonCommandRequestSchema } from '../../contracts.ts';

const mockDispatch = vi.mocked(dispatchCommand);

// A representative, structurally rich daemon payload so the parity assertions
// exercise nested objects/arrays rather than a trivial flat record.
const REPRESENTATIVE_PAYLOAD = {
  message: 'home-ok',
  detail: { nested: true, count: 3 },
  items: [1, 2, 3],
} as const;

function makeIosSession(name: string): SessionState {
  return {
    name,
    createdAt: 1_700_000_000_000,
    actions: [],
    device: {
      platform: 'ios',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/set',
    },
  };
}

function makeHandler(sessionStore = makeSessionStore('agent-device-router-cost-')) {
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

function baseRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'cost-session',
    command: 'home',
    positionals: [],
    flags: {},
    ...overrides,
  };
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async () => ({ ...REPRESENTATIVE_PAYLOAD }));
});

test('(a) flag-off identity: meta.includeCost absent === no meta at all, byte-identical and no cost', async () => {
  const { sessionStore, handler } = makeHandler();
  sessionStore.set('cost-session', makeIosSession('cost-session'));

  const respNoMeta = await handler(baseRequest());
  const respMetaWithoutCost = await handler(baseRequest({ meta: {} }));

  // The serialized wire shape must be identical whether `meta` is omitted or
  // present-without-includeCost. This is the Maestro `.ad` recompare invariant.
  expect(JSON.stringify(respNoMeta)).toBe(JSON.stringify(respMetaWithoutCost));

  expect(respNoMeta.ok).toBe(true);
  expect(respMetaWithoutCost.ok).toBe(true);
  if (respMetaWithoutCost.ok) {
    expect('cost' in (respMetaWithoutCost.data ?? {})).toBe(false);
  }
  if (respNoMeta.ok) {
    expect(respNoMeta.data).toEqual(REPRESENTATIVE_PAYLOAD);
  }
});

test('(b) flag-on additive-only: cost.wallClockMs is the ONLY delta vs flag-off', async () => {
  const { sessionStore, handler } = makeHandler();
  sessionStore.set('cost-session', makeIosSession('cost-session'));

  const respFlagOff = await handler(baseRequest());
  const respFlagOn = await handler(baseRequest({ meta: { includeCost: true } }));

  expect(respFlagOff.ok).toBe(true);
  expect(respFlagOn.ok).toBe(true);
  if (!respFlagOff.ok || !respFlagOn.ok) return;

  const cost = respFlagOn.data?.cost;
  expect(typeof cost?.wallClockMs).toBe('number');
  expect(cost?.wallClockMs).toBeGreaterThanOrEqual(0);

  // Deleting the single added key must leave a payload deep-equal to flag-off.
  delete respFlagOn.data?.cost;
  expect(respFlagOn.data).toEqual(respFlagOff.data);
});

test('(c) error path: a failing request with includeCost:true produces NO cost', async () => {
  const { sessionStore, handler } = makeHandler();
  sessionStore.set('cost-session', makeIosSession('cost-session'));

  // Conflicting explicit selector under a reject lock policy fails before dispatch.
  const failingRequest = baseRequest({
    flags: { udid: 'SIM-999' },
    meta: { lockPolicy: 'reject', includeCost: true },
  });

  const errOn = await handler(failingRequest);
  expect(errOn.ok).toBe(false);
  // The graft is gated on `response.ok`, so an error response is returned
  // untouched: it carries an `error` (no `data`) and never a `cost` key.
  expect('cost' in errOn).toBe(false);
  expect((errOn as { data?: unknown }).data).toBeUndefined();
  if (!errOn.ok) {
    expect(errOn.error.code).toBe('INVALID_ARGS');
    expect('cost' in errOn.error).toBe(false);
  }
});

test('(d) boundary survival: meta.includeCost survives daemonCommandRequestSchema parsing', () => {
  const parsed = daemonCommandRequestSchema.parse({
    command: 'home',
    positionals: [],
    meta: { includeCost: true },
  });
  expect(parsed.meta?.includeCost).toBe(true);

  const parsedOff = daemonCommandRequestSchema.parse({
    command: 'home',
    positionals: [],
    meta: {},
  });
  expect(parsedOff.meta?.includeCost).toBeUndefined();
});
