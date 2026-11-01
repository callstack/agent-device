import { test, vi, expect } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  cleanupLeftInstancesRunning,
  createLeftInstanceRunning,
  disposeLimrunLeaseOwner,
  type LimrunDisposalHost,
} from './lease-release.ts';
import type {
  LimrunCreateOutcome,
  LimrunDisposalOutcome,
  LimrunLeaseOwner,
} from './lease-ownership.ts';

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
    return { failure: undefined, cause: undefined };
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

/**
 * A delete Limrun refused keeps its own error on the disposal outcome, and the refusals every route raises
 * carry it as their cause — where a cause renders — beside the text that says the delete was unconfirmed.
 */
test("a refused delete reports its own error as the refusal's cause", async () => {
  await import('./lifecycle-budget.ts');
  const refusal = new Error('Limrun refused to delete the instance');
  const host: LimrunDisposalHost = {
    deleteInstance: async () => ({
      failure: 'Limrun refused to delete the instance',
      cause: refusal,
    }),
    endCapture: async () => undefined,
  };
  const owner = ownerWithRentedInstance(
    Promise.resolve<LimrunCreateOutcome>({ status: 'failed', error: new Error('boot failed') }),
  );
  const outcome = await disposeLimrunLeaseOwner(host, owner);
  expect(outcome.cleanup).toBe('uncertain');
  expect(outcome.cause).toBe(refusal);

  // The allocation's refusal names both what it could not settle and why its create failed at all.
  const lease = (owner as unknown as { lease: DeviceLease }).lease;
  const thrown = captureThrow(() =>
    createLeftInstanceRunning(lease, outcome, new Error('boot failed')),
  );
  expect(thrown.details?.reason).toBe('limrun_instance_delete_unconfirmed');
  expect(String(thrown.details?.cause)).toContain('boot failed');
  expect(thrown.cause).toBe(refusal);
});

/**
 * A daemon close that could not end two leases names both of them and why each is still held, not only the
 * first — every one of them may need to be named to Limrun by hand.
 */
test('a close that could not end two leases reports both reasons', async () => {
  const refusal = new Error('Limrun refused to delete the instance');
  const outcomes: LimrunDisposalOutcome[] = [
    {
      cleanup: 'uncertain',
      instanceId: 'android-instance-1',
      failure: 'delete one refused',
      cause: refusal,
      capture: undefined,
    },
    {
      cleanup: 'uncertain',
      instanceId: undefined,
      failure: undefined,
      cause: undefined,
      capture: undefined,
    },
  ];
  const thrown = captureThrow(() => cleanupLeftInstancesRunning(outcomes));
  expect(thrown.details?.reason).toBe('limrun_instance_delete_unconfirmed');
  expect(thrown.details?.limrunInstanceIds).toEqual(['android-instance-1']);
  expect(String(thrown.details?.cause)).toContain('delete one refused');
  expect(String(thrown.details?.cause)).toContain('an unconfirmed delete');
  expect(thrown.cause).toBe(refusal);
});

function captureThrow(raise: () => never): AppError {
  try {
    raise();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the refusal to throw');
}

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
