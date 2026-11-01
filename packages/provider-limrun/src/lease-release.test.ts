import { test, vi, expect } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type Limrun from '@limrun/api';
import {
  allocationRefusedForTake,
  cleanupLeftInstancesRunning,
  createLeftInstanceRunning,
  disposeLimrunLeaseOwner,
  releaseLimrunLease,
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
  const freed: string[] = [];
  const host: LimrunDisposalHost = {
    deleteInstance: deleteHost,
    endCapture: async () => undefined,
    ownerHoldsNothing: (owner) => freed.push(owner.lease.leaseId),
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
    await vi.advanceTimersByTimeAsync(0);
    expect(deleteHost).toHaveBeenCalledOnce();

    // The one request confirming is enough: the joined end records the instance as deleted.
    reportDelete();
    await vi.advanceTimersByTimeAsync(DISPOSAL_SETTLE_WAIT_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(owner.deletedInstanceId).toBe('android-instance-1');
  // The instance is gone and the host resources are down, so this owner's lease is given back: the route
  // that ends this instance had already refused its caller, and that caller is not coming back to be told.
  expect(freed).toEqual(['lease-release-join']);
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
    ownerHoldsNothing: () => {},
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

/**
 * The label-based recovery route deletes through the same helper every other route deletes with: a 404 is
 * Limrun answering that the instance is gone, and a delete it could not confirm refuses with the typed error
 * naming every instance the labels carried, because the sweep that retries this route has nothing else to go on.
 */
test('recovery by labels confirms a gone instance and reports every id it ended', async () => {
  const deletes: string[] = [];
  const limrun = labeledInstancesClient(
    ['android-instance-a', 'android-instance-b'],
    async (id) => {
      deletes.push(id);
    },
  );
  const record = await releaseLimrunLease(limrun, leaseForRecovery(), undefined);
  expect(deletes).toEqual(['android-instance-a', 'android-instance-b']);
  expect(record).toMatchObject({
    limrunInstanceId: 'android-instance-a',
    limrunInstanceIds: ['android-instance-a', 'android-instance-b'],
    limrunInstanceCount: 2,
  });
});

test('recovery stops waiting for a delete whose response never finishes', async () => {
  await import('./lifecycle-budget.ts');
  let reportDelete!: () => void;
  const pending = new Promise<void>((resolve) => {
    reportDelete = resolve;
  });
  const limrun = labeledInstancesClient(['android-instance-a'], async () => await pending);
  let outcome: unknown;
  vi.useFakeTimers();
  try {
    const released = releaseLimrunLease(limrun, leaseForRecovery(), undefined).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(outcome).toBeInstanceOf(AppError);
    expect((outcome as AppError).details?.reason).toBe('limrun_instance_delete_unconfirmed');
    expect((outcome as AppError).details?.hint).toContain('android-instance-a');
    reportDelete();
    await released;
  } finally {
    reportDelete();
    vi.useRealTimers();
  }
});

test('recovery by labels treats a 404 as confirmed, the way every other delete route does', async () => {
  const limrun = labeledInstancesClient(['android-instance-a'], async () => {
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  const record = await releaseLimrunLease(limrun, leaseForRecovery(), undefined);
  expect(record).toMatchObject({ limrunInstanceId: 'android-instance-a' });
});

/**
 * A label delete Limrun refused is a lease the daemon's sweep must retry: the refusal is the typed one, it
 * names the instance still in question beside every id the labels had, and the confirmed ones are said apart.
 */
test('recovery by labels refuses with every id when a delete is not confirmed', async () => {
  const limrun = labeledInstancesClient(
    ['android-instance-a', 'android-instance-b', 'android-instance-c'],
    async (id) => {
      if (id === 'android-instance-b') throw new Error('Limrun refused to delete the instance');
      return undefined;
    },
  );
  const thrown = await captureReject(() =>
    releaseLimrunLease(limrun, leaseForRecovery(), undefined),
  );
  expect(thrown.details?.reason).toBe('limrun_instance_delete_unconfirmed');
  expect(thrown.details?.limrunInstanceId).toBe('android-instance-b');
  expect(thrown.details?.limrunInstanceIds).toEqual([
    'android-instance-a',
    'android-instance-b',
    'android-instance-c',
  ]);
  expect(String(thrown.details?.hint)).toContain('android-instance-c');
  expect(String(thrown.details?.hint)).toContain(
    'Ask Limrun to delete: android-instance-b, android-instance-c.',
  );
  expect(String(thrown.details?.hint)).toContain('android-instance-a was confirmed deleted');
  expect(String(thrown.cause)).toContain('refused');
});

/**
 * What a close says when the work it could not finish has no instance to name yet: the lease and the work.
 * A take-refusal for an instance whose delete was not confirmed says so rather than calling it ended:
 * the refused caller is the last route that will hear the instance may still be billing.
 */
test('a take-refusal for an unconfirmed delete does not call the instance ended', () => {
  const lease = leaseForRecovery();
  const confirmed = captureThrow(() =>
    allocationRefusedForTake(lease, 'release', {
      cleanup: 'confirmed',
      instanceId: 'android-instance-1',
      failure: undefined,
      cause: undefined,
      capture: undefined,
    }),
  );
  expect(String(confirmed.details?.hint)).toContain('was ended by the release');

  const uncertain = captureThrow(() =>
    allocationRefusedForTake(lease, 'shutdown', {
      cleanup: 'uncertain',
      instanceId: 'android-instance-1',
      failure: 'delete refused',
      cause: new Error('refused'),
      capture: undefined,
    }),
  );
  expect(String(uncertain.details?.hint)).toContain('could not confirm');
  expect(String(uncertain.details?.hint)).toContain('android-instance-1');
  expect(uncertain.details?.retriable).toBe(true);
});

/**
 * The disposal's join for a capture record contains the destination tunnel's own open budget: a capture end
 * that spends almost all of that handshake and still comes to in time is answered for without a warning,
 * because the join is longer than the work inside it.
 */
/**
 * A late route that could not give the instance back must keep the lease held: the next release, recovery or
 * shutdown is the route that retries the delete, and only it can tell its caller the instance is gone.
 */
test('a late end that Limrun refused does not give the lease back', async () => {
  await import('./lifecycle-budget.ts');
  const freed: string[] = [];
  const host: LimrunDisposalHost = {
    deleteInstance: async () => ({
      failure: 'Limrun refused to delete the instance',
      cause: undefined,
    }),
    endCapture: async () => undefined,
    ownerHoldsNothing: (owner) => freed.push(owner.lease.leaseId),
  };
  let reportCreate!: () => void;
  const creation = new Promise<LimrunCreateOutcome>((resolve) => {
    reportCreate = () => resolve({ status: 'failed', error: new Error('instance boot failed') });
  });
  const owner = ownerWithRentedInstance(creation);
  vi.useFakeTimers();
  try {
    const disposal = disposeLimrunLeaseOwner(host, owner);
    await vi.advanceTimersByTimeAsync(CREATE_ANSWER_WAIT_MS + DISPOSAL_SETTLE_WAIT_MS);
    await expect(disposal).resolves.toMatchObject({ cleanup: 'uncertain' });
    // The create answers after that, and the end it owes is refused by Limrun as well: the lease stays held.
    reportCreate();
    await vi.advanceTimersByTimeAsync(DISPOSAL_SETTLE_WAIT_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(owner.deletedInstanceId).toBeUndefined();
  expect(freed).toEqual([]);
});

test('a capture end that spends its tunnel budget is still joined in time', async () => {
  await import('./lifecycle-budget.ts');
  const host: LimrunDisposalHost = {
    deleteInstance: async () => ({ failure: undefined, cause: undefined }),
    // The tunnel answers at the very end of its own 20 s budget, then the record is written.
    endCapture: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20_000);
      });
      return { phase: 'written', harPath: '/tmp/late.har', failures: { count: 0, truncated: 0 } };
    },
    ownerHoldsNothing: () => {},
  };
  const owner = ownerWithRentedInstance(
    // A create that failed but named the instance (rentedInstanceId is set by the fixture): the disposal
    // ends that instance and joins the capture record it started beside the delete.
    Promise.resolve<LimrunCreateOutcome>({
      status: 'failed',
      error: new Error('create answered after its session was gone'),
    }),
  );
  vi.useFakeTimers();
  let settled: LimrunDisposalOutcome | undefined;
  try {
    const disposal = disposeLimrunLeaseOwner(host, owner).then((outcome) => {
      settled = outcome;
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await disposal;
  } finally {
    vi.useRealTimers();
  }
  expect(settled?.cleanup).toBe('confirmed');
  expect(settled?.failure).toBeUndefined();
});

function captureReject(raise: () => Promise<unknown>): Promise<AppError> {
  return raise().then(
    () => {
      throw new Error('expected the refusal to reject');
    },
    (error: unknown) => error as AppError,
  );
}

/** A Limrun whose labels name these instances, answering every delete the way a case says. */
function labeledInstancesClient(
  instanceIds: readonly string[],
  remove: (instanceId: string) => Promise<void>,
): Limrun {
  const page = { getPaginatedItems: () => instanceIds.map((id) => ({ metadata: { id } })) };
  const resource = {
    list: async () => page,
    delete: async (instanceId: string) => await remove(instanceId),
  };
  return { iosInstances: resource, androidInstances: resource } as unknown as Limrun;
}

function leaseForRecovery(): DeviceLease {
  return {
    leaseId: 'lease-labeled-recovery',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

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
