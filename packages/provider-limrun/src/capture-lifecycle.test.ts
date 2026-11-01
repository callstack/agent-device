import { test, vi, expect } from 'vitest';
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

/**
 * A destination tunnel that answers after the release stopped waiting is written and ended all the same. When
 * that late end refuses — a capture whose traffic will not be read, a tunnel that will not close — the refusal
 * is observed where it lands: the continuation outlives every budget and every caller, so nothing above it is
 * left to catch it.
 */
test('a capture that answers late and then refuses is not loosed on the process', async () => {
  // Loaded before the clock is replaced: the late end writes its HAR through this module, and a dynamic
  // import that had to resolve under fake timers would never answer at all.
  await import('./network-har.ts');
  const rejections = watchUnhandledRejections();
  let reportOpened!: (capture: NetworkCapture) => void;
  const opening = new Promise<NetworkCapture>((opened) => {
    reportOpened = opened;
  });
  const lifecycle = new LimrunCaptureLifecycle(captureHost());
  const owner = ownerWithCapture();
  owner.capture = { phase: 'starting', opening };
  vi.useFakeTimers();
  try {
    const ended = lifecycle.end(owner);
    // The release gives up on the handshake and answers for its lease; the tunnel is still its own to end.
    await vi.advanceTimersByTimeAsync(CAPTURE_OPEN_WAIT_MS);
    expect(await ended).toBeUndefined();
    // The tunnel arrives late and refuses to be read: the end of it fails with nobody left above it.
    reportOpened({
      phase: 'capturing',
      harPath: '/tmp/sm4-late-capture.har',
      capture: {
        entries: () => [],
        failures: async () => {
          throw new Error('the destination tunnel refused to answer');
        },
        close: () => {},
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    // Asserted while the listener is still attached, and after a yield: that is the only window in which a
    // rejection this continuation loosed can be seen at all.
    vi.useRealTimers();
    await rejections.assertIsSilent();
  } finally {
    vi.useRealTimers();
    rejections.stop();
  }
});

/**
 * The record limit counts a lease whose owner still holds a capture, so the very same test spares that
 * record and no other. A lease the runtime still holds for an unconfirmed delete, whose capture is already
 * ended, keeps nothing the limit should spare: its record competes for the limit like any released one, and
 * the map cannot grow past it.
 */
test("a released lease's record competes for the limit even while its lease is still held", async () => {
  // The runtime still holds this lease; its owner no longer holds a capture.
  const stillHeld = ownerWithCapture('lease-held-no-capture');
  stillHeld.capture = undefined;
  const lifecycle = new LimrunCaptureLifecycle(captureHost([stillHeld]));
  await lifecycle.end(
    Object.assign(ownerWithCapture(stillHeld.lease.leaseId), {
      capture: { phase: 'unavailable', reason: 'capture-dir-unset' },
    }),
  );
  // Past the limit, with the held lease's record the oldest of them.
  for (let index = 0; index < 33; index += 1) {
    const released = ownerWithCapture(`lease-released-${String(index)}`);
    released.capture = { phase: 'unavailable', reason: 'capture-dir-unset' };
    await lifecycle.end(released);
  }

  // The newest record still answers, and the record of the lease that holds no capture is the one that went.
  expect(await lifecycle.list('lease-released-32', undefined)).toMatchObject({
    reason: 'capture-dir-unset',
  });
  expect(await lifecycle.list(stillHeld.lease.leaseId, undefined)).toBeUndefined();
});

function captureHost(held: readonly LimrunLeaseOwner[] = []): LimrunCaptureHost {
  return {
    harDir: undefined,
    liveSessionOf: () => undefined,
    heldOwners: () => held,
  };
}

/**
 * Collects the rejections the process would die on: the daemon's failure mode for one is to take every other
 * session down with it. The check yields to a macrotask first, because Node reports a rejection only after the
 * current microtask drain — asserting before that yield, or removing the listener without one, could pass a
 * leaked rejection unseen.
 */
function watchUnhandledRejections(): {
  assertIsSilent: () => Promise<void>;
  stop: () => void;
} {
  const seen: unknown[] = [];
  const watch = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', watch);
  return {
    assertIsSilent: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      if (seen.length > 0) assert.fail(`expected no unhandled rejection, got ${String(seen[0])}`);
    },
    stop: () => process.off('unhandledRejection', watch),
  };
}

/**
 * An owner whose lease has a destination tunnel that has not answered, and never will. A case that drives a
 * different lease overrides the id it needs.
 */
function ownerWithCapture(leaseId = 'lease-capture-join'): LimrunLeaseOwner {
  const lease = {
    leaseId,
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
