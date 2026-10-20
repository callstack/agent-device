import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  buildDaemonLifecycleRequest,
  type DaemonRuntimeOwnership,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { createDaemonLifecycleAdmission, daemonShuttingDownResponse } from './daemon-idle-reap.ts';

const TOKEN = 'daemon-token';
const FENCE = { pid: 4242, processStartTime: 'Fri Oct 17 09:00:00 2026' };

let stateDir: string;
let sessionStore: SessionStore;

beforeEach(() => {
  stateDir = mkdtempForTestSync('agent-device-daemon-lifecycle-admission-');
  sessionStore = new SessionStore(path.join(stateDir, 'sessions'), {
    env: process.env,
    cwd: process.cwd(),
  });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

type Seam = {
  admit: (handler: Handler) => (request: DaemonRequest) => Promise<DaemonResponse>;
  drained: ReturnType<typeof vi.fn>;
  served: MockHandler;
};

type Handler = (request: DaemonRequest) => Promise<DaemonResponse>;
type MockHandler = Handler & ReturnType<typeof vi.fn>;

function makeSeam(
  options: {
    ownership?: DaemonRuntimeOwnership;
    identity?: { pid: number; processStartTime: string | null };
    startingUp?: boolean;
  } = {},
): Seam {
  const drained = vi.fn();
  const admission = createDaemonLifecycleAdmission({
    token: TOKEN,
    identity: options.identity ?? FENCE,
    sessionStore,
    leaseRegistry: { listActiveLeases: () => [] },
    inFlightRequestCount: () => 0,
    startingUp: () => options.startingUp ?? false,
    drain: drained,
    ownership: () => options.ownership ?? 'detached',
  });
  return {
    admit: admission.admit,
    drained,
    served: vi.fn(async () => ({ ok: true })) as MockHandler,
  };
}

function lifecycleRequest(
  overrides: {
    token?: string;
    fence?: { pid: number; processStartTime: string | null };
    requestId?: string;
  } = {},
): DaemonRequest {
  return buildDaemonLifecycleRequest({
    token: overrides.token ?? TOKEN,
    fence: overrides.fence ?? FENCE,
    requestId: overrides.requestId ?? 'quiesce-test',
  });
}

function ordinaryRequest(): DaemonRequest {
  return { token: TOKEN, session: 'default', command: 'devices', positionals: [] };
}

/** One open session, which is work a stop-if-idle must not walk away from. */
function openOneSession(): void {
  sessionStore.publish('busy-session', makeIosSession('busy-session'));
}

function reasonOf(response: DaemonResponse): unknown {
  return response.ok ? undefined : response.error.details?.reason;
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('a lifecycle request is answered at the seam and never reaches the handler it guards', async () => {
  const { admit, drained, served } = makeSeam();
  assert.deepEqual(await admit(served)(lifecycleRequest()), {
    ok: true,
    data: { outcome: 'draining' },
  });
  await settled();
  assert.equal(drained.mock.calls.length, 1);
  assert.equal(served.mock.calls.length, 0);
});

test('a host-owned runtime refuses quiesce and keeps serving', async () => {
  const { admit, drained, served } = makeSeam({ ownership: 'embedded' });
  assert.equal(reasonOf(await admit(served)(lifecycleRequest())), 'daemon-owner-embedded');
  await settled();
  assert.equal(drained.mock.calls.length, 0);
  assert.deepEqual(await admit(served)(ordinaryRequest()), { ok: true });
});

test('a detached daemon refuses quiesce while it holds work', async () => {
  openOneSession();

  const held = makeSeam({ ownership: 'detached' });
  const refusal = await held.admit(held.served)(lifecycleRequest());
  assert.equal(reasonOf(refusal), 'daemon-busy');
  if (!refusal.ok) assert.equal(refusal.error.details?.sessions, 1);
  await settled();
  assert.equal(held.drained.mock.calls.length, 0);
  // The refusal reopened admission, so this daemon is still serving its sessions.
  assert.deepEqual(await held.admit(held.served)(ordinaryRequest()), { ok: true });
});

test('a daemon still starting refuses quiesce and keeps serving while it starts', async () => {
  const { admit, drained, served } = makeSeam({
    ownership: 'detached',
    startingUp: true,
  });
  const refusal = await admit(served)(lifecycleRequest());
  assert.equal(reasonOf(refusal), 'daemon-busy');
  if (!refusal.ok) assert.equal(refusal.error.details?.startingUp, true);
  await settled();
  assert.equal(drained.mock.calls.length, 0);
  assert.deepEqual(
    await admit(served)(ordinaryRequest()),
    { ok: true },
    'a refusal keeps admission open',
  );
});

test('quiesce refuses a wrong token, a remote origin, and any other instance', async () => {
  const ownership = 'detached';

  const seam = makeSeam({ ownership });
  const wrongToken = await seam.admit(seam.served)(lifecycleRequest({ token: 'other' }));
  assert.equal(!wrongToken.ok && wrongToken.error.code, 'UNAUTHORIZED');
  assert.equal(seam.drained.mock.calls.length, 0);

  const remote = await seam.admit(seam.served)({
    ...lifecycleRequest(),
    internal: { publicNetworkOnly: true },
  });
  assert.equal(!remote.ok && remote.error.code, 'UNAUTHORIZED');

  for (const [label, fence] of [
    ['recycled pid', { pid: FENCE.pid + 1, processStartTime: FENCE.processStartTime }],
    ['other lifetime', { pid: FENCE.pid, processStartTime: 'Sat Oct 18 09:00:00 2026' }],
    ['no recorded birth', { pid: FENCE.pid, processStartTime: null }],
  ] as const) {
    const addressed = makeSeam({ ownership });
    const response = await addressed.admit(addressed.served)(lifecycleRequest({ fence }));
    assert.equal(reasonOf(response), 'daemon-instance-mismatch', label);
    await settled();
    assert.equal(addressed.drained.mock.calls.length, 0, label);
  }
  // A runtime that cannot prove its own birth cannot be addressed at all, through quiesce: a pid alone
  // cannot tell this lifetime from the process that recycled its number, and a drain would end a
  // stranger's daemon. Admission stays open, so that daemon is still serving.
  const unprovable = makeSeam({
    ownership: 'detached',
    identity: { ...FENCE, processStartTime: null },
  });
  const refused = unprovable.served;
  assert.equal(
    reasonOf(await unprovable.admit(refused)(lifecycleRequest())),
    'daemon-instance-mismatch',
  );
  await settled();
  assert.equal(unprovable.drained.mock.calls.length, 0, 'a refusal never drained');
  assert.deepEqual(
    await unprovable.admit(refused)(ordinaryRequest()),
    { ok: true },
    'an unaddressable identity still serves its own requests',
  );
});

test('a second lifecycle request after one was accepted is answered as draining, not re-drained', async () => {
  const { admit, drained } = makeSeam();
  assert.deepEqual(await admit(async () => ({ ok: true }))(lifecycleRequest()), {
    ok: true,
    data: { outcome: 'draining' },
  });
  assert.deepEqual(
    await admit(async () => ({ ok: true }))(lifecycleRequest({ requestId: 'second' })),
    { ok: true, data: { outcome: 'draining' } },
  );
  await settled();
  assert.equal(drained.mock.calls.length, 1);
});

test('every request that is not a lifecycle one is refused once a drain was accepted', async () => {
  const { admit, served } = makeSeam();
  await admit(served)(lifecycleRequest());
  assert.deepEqual(await admit(served)(ordinaryRequest()), daemonShuttingDownResponse());
  assert.equal(served.mock.calls.length, 0);
});
