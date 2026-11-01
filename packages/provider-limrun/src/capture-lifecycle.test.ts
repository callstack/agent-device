import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceLease } from '@agent-device/contracts/device';
import { LimrunCaptureLifecycle, type LimrunCaptureHost } from './capture-lifecycle.ts';
import type { LimrunLeaseOwner } from './lease-ownership.ts';
import type { NetworkCapture } from './network-har.ts';

/** Longer than the lifecycle's budget for a destination tunnel that is still being opened. */
const CAPTURE_OPEN_WAIT_MS = 25_000;

/**
 * A repeat allocation joins the start its owner is already running, within the budget a read or a teardown
 * gives that same handshake.
 */
test('a repeat allocation stops waiting on a destination tunnel that never answers', async () => {
  vi.useFakeTimers();
  const lifecycle = new LimrunCaptureLifecycle(captureHost());
  const owner = ownerWithCapture();
  let joined = false;
  const joining = lifecycle.start(owner, undefined).then(() => {
    joined = true;
  });
  try {
    // Below the budget the join is still waiting: only its expiry ends it, not an early return.
    await vi.advanceTimersByTimeAsync(19_000);
    await Promise.resolve();
    assert.ok(!joined, 'expected the join to keep waiting inside its budget');
    await vi.advanceTimersByTimeAsync(CAPTURE_OPEN_WAIT_MS);
    await joining;
  } finally {
    vi.useRealTimers();
  }

  assert.ok(joined, 'expected the joining allocation to stop waiting on the stalled tunnel');
  // What the stalled start goes on to open stays the owner's to publish, and its teardown's to end: the
  // joiner leaves the capture where the allocation that started it put it.
  assert.equal(owner.capture?.phase, 'starting');
});

/**
 * An `artifacts` read for a capture whose destination tunnel is still being opened answers on the spot:
 * the read has nothing to wait for — the tunnel belongs to the lease's release, and a stalled handshake
 * would otherwise hold the request for the whole open budget to say nothing new.
 */
test('an artifacts read answers at once for a capture whose tunnel is still opening', async () => {
  const lifecycle = new LimrunCaptureLifecycle(captureHost());
  const owner = ownerWithCapture();
  const listed = await Promise.race([
    lifecycle.list(owner.lease.leaseId, owner.capture),
    new Promise<'stalled'>((resolve) => {
      const timer = setTimeout(() => resolve('stalled'), 250);
      timer.unref?.();
    }),
  ] as const);
  assert.equal(listed, undefined);
});

function captureHost(held: readonly LimrunLeaseOwner[] = []): LimrunCaptureHost {
  return {
    harDir: undefined,
    liveSessionOf: () => undefined,
    heldOwners: () => held,
  };
}

/** An owner whose lease has a destination tunnel that has not answered, and never will. */
function ownerWithCapture(): LimrunLeaseOwner {
  const lease = {
    leaseId: 'lease-capture-join',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  } satisfies DeviceLease;
  const opening = new Promise<NetworkCapture>(() => {});
  return {
    lease,
    platform: 'android',
    creation: Promise.resolve({ status: 'ready', session: undefined, appAlias: undefined }),
    state: { phase: 'live' },
    rentedInstanceId: undefined,
    session: undefined,
    capture: { phase: 'starting', opening },
    appAlias: undefined,
    deletedInstanceId: undefined,
  } as unknown as LimrunLeaseOwner;
}
