import { test, vi, expect } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { disposeLimrunLeaseOwner, type LimrunDisposalHost } from './lease-release.ts';
import type { LimrunCreateOutcome, LimrunLeaseOwner } from './lease-ownership.ts';

/*
 * Each wait is longer than the budgets it steps past: a disposal's create wait, and everything a disposal
 * left without a create answer may still wait for — one delete, the local teardown, one capture record.
 */
const CREATE_ANSWER_WAIT_MS = 130_000;
const DISPOSAL_SETTLE_WAIT_MS = 110_000;

/**
 * A create that answers after its disposal stopped waiting owes its end to the disposal already over. If that
 * disposal's delete is still with Limrun, the late end joins it: one instance is deleted by one request.
 */
test('a create that answers late joins the delete its disposal already started', async () => {
  // Loaded before the clock is replaced, so the disposal's own budget timers are fake timers.
  await import('./lifecycle-budget.ts');
  let reportDelete!: () => void;
  const deleteHost = vi.fn<LimrunDisposalHost['deleteInstance']>(async () => {
    await new Promise<void>((resolve) => {
      reportDelete = resolve;
    });
    return undefined;
  });
  const host: LimrunDisposalHost = {
    deleteInstance: deleteHost,
    endCapture: async () => undefined,
  };
  let reportCreate!: () => void;
  const creation = new Promise<LimrunCreateOutcome>((resolve) => {
    // A create that rented the instance and then failed, after its disposal had given up on it.
    reportCreate = () => resolve({ status: 'failed', error: new Error('instance boot failed') });
  });
  const owner = ownerWithRentedInstance(creation);

  vi.useFakeTimers();
  try {
    const disposal = disposeLimrunLeaseOwner(host, owner);
    // The disposal stops waiting on the create and asks Limrun once to end the instance it did rent.
    await vi.advanceTimersByTimeAsync(CREATE_ANSWER_WAIT_MS);
    expect(deleteHost).toHaveBeenCalledOnce();
    // Its own delete then runs out its deadline, and the disposal refuses its caller.
    await vi.advanceTimersByTimeAsync(DISPOSAL_SETTLE_WAIT_MS);
    await expect(disposal).resolves.toMatchObject({ cleanup: 'uncertain' });

    // The create answers now. The end it owes is this disposal's, and it joins the request Limrun already
    // has for this instance rather than sending a second one.
    reportCreate();
    await vi.advanceTimersByTimeAsync(DISPOSAL_SETTLE_WAIT_MS);
    expect(deleteHost).toHaveBeenCalledOnce();

    // The one request confirming is enough: the joined end records the instance as deleted.
    reportDelete();
    await vi.advanceTimersByTimeAsync(DISPOSAL_SETTLE_WAIT_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(owner.deletedInstanceId).toBe('android-instance-1');
});

/** An owner whose create has rented an instance but has not answered, taken by a disposal. */
function ownerWithRentedInstance(creation: Promise<LimrunCreateOutcome>): LimrunLeaseOwner {
  const lease = {
    leaseId: 'lease-release-join',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  } satisfies DeviceLease;
  return {
    lease,
    platform: 'android',
    creation,
    state: { phase: 'releasing', by: 'release' },
    rentedInstanceId: 'android-instance-1',
    session: undefined,
    localRelease: undefined,
    keepAlive: undefined,
    capture: undefined,
    appAlias: undefined,
    deletedInstanceId: undefined,
    pendingDelete: undefined,
  } as unknown as LimrunLeaseOwner;
}
