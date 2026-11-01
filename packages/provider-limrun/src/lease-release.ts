import type Limrun from '@limrun/api';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { cleanupLimrunAndroidAdbTunnel } from './android.ts';
import { CAPTURE_OPEN_BUDGET_MS } from './capture-lifecycle.ts';
import { deleteLimrunInstance } from './client-options.ts';
import type { LimrunBudgetOutcome } from './lifecycle-budget.ts';
import { LIMRUN_PROVIDER, platformForLimrunLeaseBackend, type LimrunPlatform } from './device.ts';
import type {
  LimrunDeleteResult,
  LimrunDisposalOutcome,
  LimrunLeaseOwner,
  LimrunRuntimeSession,
  LimrunTeardownRoute,
} from './lease-ownership.ts';
import type { SettledNetworkCapture } from './network-har.ts';

/**
 * Everything this runtime does once a lease has been taken for good: end what its owner holds, and answer with
 * what came of it. One lease's disposal runs here, and every route that ends a lease — release, daemon close,
 * expired-lease recovery, and the create that failed — answers from the same outcome, so none of them can
 * report a lease as released on anything short of Limrun confirming the delete.
 *
 * Every wait here is bounded. Work that outlives its deadline keeps running and stays observed: this module
 * ends what it eventually makes, and reports what it could not, rather than holding a caller open.
 */

/**
 * How long a disposal waits for the create to say what it rented. The create itself keeps Limrun's own
 * timeouts: this bounds only the disposal's wait, so an instance is never held open by a create that stopped
 * answering, and its owner disposes what that create eventually names.
 */
const CREATE_ANSWER_BUDGET_MS = 120_000;

/**
 * How long a disposal waits for one delete. The SDK clears a request's timer before it reads the response body,
 * so a DELETE whose body never arrives would otherwise hold the release, the daemon close and every joining
 * allocation open forever.
 */
const DELETE_ANSWER_BUDGET_MS = 30_000;

/**
 * How long a disposal waits for the local resources it started beside the delete: the instance connection and
 * the Android ADB endpoint, whose `adb connect` the SDK runs without a deadline.
 */
const LOCAL_TEARDOWN_BUDGET_MS = 45_000;

/**
 * How long a disposal waits for a capture's HAR record, which is reporting and never a reason to hold a lease.
 * The disposal joins a capture end that contains the destination tunnel's own open budget, so this is that
 * handshake plus a window of its own for writing the HAR: a join shorter than the work inside it would report
 * a handshake that is still inside its own stated budget as a record that refused.
 */
const CAPTURE_RECORD_BUDGET_MS = CAPTURE_OPEN_BUDGET_MS + 10_000;

/**
 * What a disposal may ask of the runtime that owns the lease, and nothing else: the delete of one instance, and
 * the end of one lease's capture. Keeping the disposal to these two is what lets it end an owner without
 * reaching back into the routes that allocate and read one, and without deciding when a lease is free again.
 */
export type LimrunDisposalHost = Readonly<{
  /** One instance delete: whether Limrun has the instance gone, and what refused it otherwise. */
  deleteInstance(platform: LimrunPlatform, instanceId: string): Promise<LimrunDeleteResult>;
  /** Ends one lease's capture and answers with its record, for a runtime that has captured something. */
  endCapture(owner: LimrunLeaseOwner): Promise<SettledNetworkCapture | undefined>;
  /**
   * Tells the runtime this owner stands for nothing any more, so its lease may be allocated again. Only a
   * route that finished ending the instance and put down the host resources may say this, and only the
   * runtime's own take answers for a lease that is over; this is for the route whose disposal had already
   * refused its caller, and whose caller will never come back to be told the instance is gone.
   */
  ownerHoldsNothing(owner: LimrunLeaseOwner): void;
}>;

/**
 * Ends what one taken owner stands for: the instance its create made or rented, with every resource the owner
 * holds beside it. This is the only place an instance is ended, and an owner is taken by exactly one route at a
 * time, so one instance is ended exactly once.
 */
export async function disposeLimrunLeaseOwner(
  host: LimrunDisposalHost,
  owner: LimrunLeaseOwner,
): Promise<LimrunDisposalOutcome> {
  const {
    awaitLimrunWithinBudget,
    joinOutcomeFailures,
    keepLimrunObserved,
    workOutstandingFailure,
  } = await import('./lifecycle-budget.ts');
  const create = await awaitLimrunWithinBudget(owner.creation, CREATE_ANSWER_BUDGET_MS);
  // The create answered too late for this disposal to wait on it; what it goes on to name is still this
  // disposal's to end.
  if (!create.ok) return await disposeUnansweredCreate(host, owner);
  // The owner records what its create actually made — the instance the moment Limrun named it, the session the
  // moment it was built — so a create that failed or refused its caller is disposed from those, exactly like
  // one that answered.
  const session = owner.session;
  const instanceId = session?.instanceId ?? owner.rentedInstanceId;
  if (instanceId === undefined) return await disposeUnrented(host, owner);
  // The capture's record is optional reporting, and local teardown can outlive its own steps: neither is
  // allowed to stand between this disposal and the delete that stops the instance from being billed, so both
  // are started here and joined after it. Both are observed in this same step: a step of either one that
  // refuses before the join below is reached has this disposal as its observer from the moment it started,
  // so no refusal of a resource this route already owns can reach the process as an unhandled rejection.
  const capture = keepLimrunObserved(host.endCapture(owner));
  const local = keepLimrunObserved(releaseOwnerResources(owner));
  const instance = await endInstance(host, owner, instanceId);
  const stuck = await awaitLocalTeardown(local);
  // The record is optional reporting joined last: a capture that refuses to be written cannot keep a release
  // from answering for the instance it ended, and is still listable once it does come to.
  const joined = await awaitLimrunWithinBudget(capture, CAPTURE_RECORD_BUDGET_MS);
  return {
    cleanup: instance.cleanup,
    instanceId,
    failure: joinOutcomeFailures(
      instance.failure,
      joinOutcomeFailures(stuck, captureRecordOutcome(joined, workOutstandingFailure)),
    ),
    cause: instance.cause,
    capture: joined.ok ? joined.value : undefined,
  };
}

/**
 * What the joined capture record leaves to report: nothing, a refusal of the record itself, or a wait
 * that ran out. A refusal is reported as what it is, because a record that will never be written is not
 * the same thing as one that may still arrive.
 */
function captureRecordOutcome(
  joined: LimrunBudgetOutcome<SettledNetworkCapture | undefined>,
  outstanding: (work: string, budgetMs: number) => string,
): string | undefined {
  if (joined.ok) return undefined;
  return 'rejected' in joined
    ? 'Capture record refused to be written'
    : outstanding('Capture record', CAPTURE_RECORD_BUDGET_MS);
}

/**
 * Ends what a disposal holds when the create it waited for never answered. Nothing is known to be running, so
 * the lease is kept held and refused rather than given back — and the create is watched, because whatever it
 * eventually names belongs to this disposal and to no other route: a daemon close promises no next pass.
 */
async function disposeUnansweredCreate(
  host: LimrunDisposalHost,
  owner: LimrunLeaseOwner,
): Promise<LimrunDisposalOutcome> {
  const { joinOutcomeFailures, keepLimrunObserved, workOutstandingFailure } =
    await import('./lifecycle-budget.ts');
  // Observed the step it starts in, like the disposal's other early work: this route answers only after
  // the local teardown below, so a capture end that refuses meanwhile has its observer already beside it.
  const capture = keepLimrunObserved(awaitEndedCapture(host, owner));
  const outstanding = workOutstandingFailure(
    `Instance create for lease '${owner.lease.leaseId}'`,
    CREATE_ANSWER_BUDGET_MS,
  );
  // Observed on both branches: this continuation outlives every budget, so a failure of it must not reach
  // the process as an unhandled rejection.
  owner.creation.then(
    () => {
      void endWhatTheCreateNamed(host, owner).catch(() => undefined);
    },
    () => undefined,
  );
  const instanceId = owner.rentedInstanceId;
  if (instanceId === undefined) {
    return {
      cleanup: 'uncertain',
      instanceId: undefined,
      failure: outstanding,
      cause: undefined,
      capture: await capture,
    };
  }
  // An instance is already named, so this disposal ends the billing it can see and leaves the create's silence
  // as what keeps the lease held.
  const instance = await endInstance(host, owner, instanceId);
  // Reported, not thrown: a local step that refuses is one this disposal can no longer fix, and the delete
  // it ran beside has already been answered for.
  const stuck = await awaitLocalTeardown(releaseOwnerResources(owner));
  return {
    cleanup: instance.cleanup,
    instanceId,
    failure: joinOutcomeFailures(instance.failure, stuck ?? outstanding),
    cause: instance.cause,
    capture: await capture,
  };
}

/**
 * Ends what a create answered for after its disposal had refused its caller: the instance it rented, if that is
 * still owed, and every host resource the session it built holds. Nothing else is left to do this — the lease
 * was refused to its caller, and no later route is promised.
 */
async function endWhatTheCreateNamed(
  host: LimrunDisposalHost,
  owner: LimrunLeaseOwner,
): Promise<void> {
  const instanceId = owner.rentedInstanceId;
  let owed = false;
  if (instanceId !== undefined && owner.deletedInstanceId !== instanceId) {
    const ended = await endInstance(host, owner, instanceId);
    // Limrun has not given this instance back: the lease stays held for the next route, which is the one
    // that will retry the delete and tell its caller what came of it.
    owed = ended.cleanup === 'uncertain';
  }
  const stuck = await awaitLocalTeardown(releaseOwnerResources(owner));
  // The instance is gone, or was never this runtime's to delete, and nothing local refuses: this owner
  // stands for nothing, so the lease may be allocated again. No take will give it back the usual way — the
  // disposal that took it had already refused its caller, and that caller is not coming back.
  if (!owed && stuck === undefined) host.ownerHoldsNothing(owner);
}

/**
 * Ends what a disposal holds when its create answered and no instance is named for the lease: nothing this
 * runtime rented is running, so the lease can be given back.
 */
async function disposeUnrented(
  host: LimrunDisposalHost,
  owner: LimrunLeaseOwner,
): Promise<LimrunDisposalOutcome> {
  return {
    cleanup: 'none',
    instanceId: undefined,
    failure: undefined,
    cause: undefined,
    capture: await awaitEndedCapture(host, owner),
  };
}

/**
 * Ends one lease's capture within the budget a record is given everywhere else, so a HAR write that stops
 * answering cannot hold a disposal that has already ended, or owes nothing, for longer than reporting is worth.
 */
async function awaitEndedCapture(
  host: LimrunDisposalHost,
  owner: LimrunLeaseOwner,
): Promise<SettledNetworkCapture | undefined> {
  const { awaitLimrunWithinBudget } = await import('./lifecycle-budget.ts');
  const ended = await awaitLimrunWithinBudget(host.endCapture(owner), CAPTURE_RECORD_BUDGET_MS);
  return ended.ok ? ended.value : undefined;
}

/** What ending one instance came to: whether Limrun confirmed it gone, and what it said otherwise. */
type LimrunInstanceEnd = Readonly<{
  cleanup: LimrunDisposalOutcome['cleanup'];
  failure: string | undefined;
  cause: unknown;
}>;

/**
 * Ends one owner's instance within a deadline of its own. An attached instance is the caller's own and is never
 * deleted here; a delete Limrun already confirmed answers for itself; and a delete that never answers keeps the
 * lease held and stays observed, because what it confirms late is what frees the lease. Ownership is read from
 * the owner and not from an argument, so no route that reaches an instance can default an attached one to
 * being ours to delete.
 */
async function endInstance(
  host: LimrunDisposalHost,
  owner: LimrunLeaseOwner,
  instanceId: string,
): Promise<LimrunInstanceEnd> {
  const { awaitLimrunWithinBudget, workOutstandingFailure } = await import('./lifecycle-budget.ts');
  if (owner.deletedInstanceId === instanceId)
    return { cleanup: 'confirmed', failure: undefined, cause: undefined };
  if ((owner.session?.ownership ?? 'created') === 'attached') {
    return { cleanup: 'attached', failure: undefined, cause: undefined };
  }
  const requested =
    owner.pendingDelete?.instanceId === instanceId
      ? // This owner already has a delete with Limrun for this instance, however far from answering. One
        // instance is deleted by one request: a second route that owes its end waits on that request.
        owner.pendingDelete.requested
      : host.deleteInstance(owner.platform, instanceId);
  if (owner.pendingDelete?.instanceId !== instanceId) {
    const inFlight = { instanceId, requested };
    owner.pendingDelete = inFlight;
    // A delete that answered leaves nothing for a later route to join: a confirmed one is recorded as
    // deleted, and a refused one is that later route's to retry.
    const forgotten = (): void => {
      if (owner.pendingDelete === inFlight) owner.pendingDelete = undefined;
    };
    void requested.then(forgotten, forgotten);
  }
  const deleted = await awaitLimrunWithinBudget(requested, DELETE_ANSWER_BUDGET_MS);
  if (!deleted.ok) {
    // Both branches of the request are answered for here: this continuation outlives its budget, and the
    // route that started it has stopped waiting, so nothing it reports later may reach the process as an
    // unhandled rejection.
    void requested.then(
      (answer) => {
        if (answer.failure === undefined) confirmLateDelete(owner, instanceId);
      },
      () => undefined,
    );
    return {
      cleanup: 'uncertain',
      failure:
        'rejected' in deleted
          ? `Delete of instance '${instanceId}' could not be attempted`
          : workOutstandingFailure(`Delete of instance '${instanceId}'`, DELETE_ANSWER_BUDGET_MS),
      cause: undefined,
    };
  }
  if (deleted.value.failure === undefined) owner.deletedInstanceId = instanceId;
  return {
    cleanup: deleted.value.failure === undefined ? 'confirmed' : 'uncertain',
    failure: deleted.value.failure,
    cause: deleted.value.cause,
  };
}

/**
 * Records a delete that confirmed after its disposal stopped waiting for it. The lease stays held for its next
 * route, which is the one that has to tell its caller the instance is gone; this only makes sure that route
 * never asks Limrun to delete the same instance twice.
 */
function confirmLateDelete(owner: LimrunLeaseOwner, instanceId: string): void {
  owner.deletedInstanceId = instanceId;
}

/**
 * Ends the resources one owner holds besides its instance: the keep-alive beat that would otherwise ping a
 * deleted instance forever, the instance connection, and the Android ADB tunnel with its reverse mappings. One
 * release answers for one owner, whichever route asked first, so a session that arrives after this started is
 * still released by it rather than by a second pass nobody is promised.
 */
function releaseOwnerResources(owner: LimrunLeaseOwner): Promise<void> {
  owner.localRelease ??= releaseLocalResources(owner);
  return owner.localRelease;
}

async function releaseLocalResources(owner: LimrunLeaseOwner): Promise<void> {
  if (owner.keepAlive) clearInterval(owner.keepAlive);
  owner.keepAlive = undefined;
  // The session is what holds a host endpoint open. The owner has kept it from the moment it was built, whether
  // or not the allocation that built it answered, so a create this disposal stopped waiting for is awaited here
  // rather than passed over: the session it eventually builds has nowhere else to be disconnected.
  const session = owner.session ?? (await sessionTheCreateBuilt(owner));
  if (session === undefined) return;
  const { awaitLimrunWithinBudget } = await import('./lifecycle-budget.ts');
  const tunnel =
    session.platform === 'android' ? cleanupLimrunAndroidAdbTunnel(session) : Promise.resolve();
  // Disconnect closes the ADB endpoint: reverse cleanup gets its window, but cannot postpone disconnect
  // past that window. Both promises are observed before either can settle.
  const disconnect = awaitLimrunWithinBudget(tunnel, LOCAL_TEARDOWN_BUDGET_MS).then(() => {
    session.client.disconnect();
  });
  const results = await Promise.allSettled([tunnel, disconnect]);
  const refused = results.find((result) => result.status === 'rejected');
  if (refused?.status === 'rejected') throw refused.reason;
}

/** The session a create answered for, once it answers, for a release that got there first. */
async function sessionTheCreateBuilt(
  owner: LimrunLeaseOwner,
): Promise<LimrunRuntimeSession | undefined> {
  await owner.creation.catch(() => undefined);
  return owner.session;
}

/**
 * Reports the local teardown a disposal had to stop waiting for. A step that refused and a step that never
 * answered are both reported as what they are: neither is something this runtime can still fix, and the
 * delete that ran beside it has already been answered.
 */
async function awaitLocalTeardown(local: Promise<void>): Promise<string | undefined> {
  const { awaitLimrunWithinBudget, workOutstandingFailure } = await import('./lifecycle-budget.ts');
  const ended = await awaitLimrunWithinBudget(local, LOCAL_TEARDOWN_BUDGET_MS);
  if (ended.ok) return undefined;
  return 'rejected' in ended
    ? 'Local teardown refused to finish'
    : workOutstandingFailure('Local teardown', LOCAL_TEARDOWN_BUDGET_MS);
}

/** What a release answers for one lease: the instance it ended, with what it left and wrote. */
type LimrunReleaseRecord = Record<string, unknown>;

/**
 * Ends one lease from the disposal its runtime already started for it, or from what the lease's own labels
 * name when the runtime no longer holds an owner for it. A delete Limrun did not confirm keeps the lease held:
 * the release is refused, and the next release, recovery or shutdown retries the same instance rather than
 * reporting an instance released.
 *
 * The disposal is handed in rather than started here because the caller took the lease in the same step the
 * release was asked for, and no loading in between may let the allocation still waiting on its create answer
 * first.
 */
export async function releaseLimrunLease(
  limrun: Limrun | undefined,
  lease: DeviceLease,
  disposal: Promise<LimrunDisposalOutcome> | undefined,
): Promise<LimrunReleaseRecord | undefined> {
  // No disposal means this runtime holds nothing for the lease: it was never allocated here, or its disposal
  // confirmed and gave it back. What the lease has under its labels is the recovery route's.
  if (disposal === undefined) return await releaseLabeledInstances(limrun, lease);
  const outcome = await disposal;
  if (outcome.cleanup === 'uncertain') throw releaseLeftInstanceRunning(lease.leaseId, outcome);
  if (outcome.instanceId === undefined) return undefined;
  const { networkArtifacts } = await import('./network-har.ts');
  return {
    limrunInstanceId: outcome.instanceId,
    // The instance is gone, so the lease is released; what the release stopped waiting for is a warning the
    // caller still has to see, because it is a host resource this process left behind.
    ...(outcome.failure === undefined
      ? {}
      : {
          warnings: [
            {
              code: 'LIMRUN_TEARDOWN_INCOMPLETE',
              message: outcome.failure,
              limrunInstanceId: outcome.instanceId,
            },
          ],
        }),
    ...(outcome.capture ? { cloudArtifacts: networkArtifacts(outcome.capture) } : {}),
  };
}

/**
 * Ends every instance a lease's own labels name, for a lease this runtime no longer holds an owner for.
 * Every delete goes through the same helper every other route deletes with, so a 404 confirms here exactly
 * as it does there; a delete the helper could not confirm refuses with the typed unconfirmed-delete error,
 * naming every instance the labels carried and which of them are already confirmed gone. The refusal keeps
 * the lease held: the daemon's expiry sweep is the retry, and nothing else knows these ids.
 */
async function releaseLabeledInstances(
  limrun: Limrun | undefined,
  lease: DeviceLease,
): Promise<LimrunReleaseRecord | undefined> {
  const platform = platformForLimrunLeaseBackend(lease.backend);
  if (!platform || !limrun) return undefined;
  const labelSelector = `provider=${LIMRUN_PROVIDER},leaseId=${lease.leaseId}`;
  const instances =
    platform === 'ios'
      ? await limrun.iosInstances.list({ labelSelector })
      : await limrun.androidInstances.list({ labelSelector });
  const instanceIds = instances.getPaginatedItems().map((instance) => instance.metadata.id);
  const { awaitLimrunWithinBudget, workOutstandingFailure } = await import('./lifecycle-budget.ts');
  const confirmed: string[] = [];
  for (const instanceId of instanceIds) {
    const answer = await awaitLimrunWithinBudget(
      deleteLimrunInstance(limrun, platform, instanceId),
      DELETE_ANSWER_BUDGET_MS,
    );
    const deleted = answer.ok
      ? answer.value
      : {
          failure: workOutstandingFailure(
            `Delete of instance '${instanceId}'`,
            DELETE_ANSWER_BUDGET_MS,
          ),
          cause: undefined,
        };
    if (deleted.failure !== undefined) {
      throwUnconfirmedDelete(
        `Recovery could not confirm instance '${instanceId}' of lease '${lease.leaseId}' deleted`,
        { limrunInstanceId: instanceId, limrunInstanceIds: instanceIds },
        deleted.failure,
        recoveryHint(instanceIds, confirmed),
        deleted.cause,
      );
    }
    confirmed.push(instanceId);
  }
  if (instanceIds.length === 0) return undefined;
  return {
    limrunInstanceId: instanceIds[0],
    limrunInstanceIds: instanceIds,
    limrunInstanceCount: instanceIds.length,
  };
}

/** What the recovery refusal tells the operator to name to Limrun: the instance left, and those gone. */
function recoveryHint(instanceIds: readonly string[], confirmed: readonly string[]): string {
  const outstanding = instanceIds.filter((id) => !confirmed.includes(id));
  const request = `Ask Limrun to delete: ${outstanding.join(', ')}.`;
  if (confirmed.length === 0) return request;
  const gone = `${confirmed.length > 1 ? 'Instances' : 'Instance'} ${confirmed.join(', ')} ${confirmed.length > 1 ? 'were' : 'was'} confirmed deleted.`;
  return `${request} ${gone}`;
}

/**
 * What a release reports when Limrun did not confirm the delete, so the lease is still held. An unended lease
 * whose create never named an instance is answered for by the lease alone, because the operator has nothing to
 * name to Limrun yet.
 */
function releaseLeftInstanceRunning(leaseId: string, outcome: LimrunDisposalOutcome): never {
  const { instanceId } = outcome;
  return throwUnconfirmedDelete(
    `Limrun instance for lease '${leaseId}' was not confirmed deleted`,
    instanceId === undefined ? {} : { limrunInstanceId: instanceId },
    outcome.failure,
    instanceId === undefined
      ? `Release lease '${leaseId}' again once its instance create names the instance it rented.`
      : `Release lease '${leaseId}' again, or ask Limrun to delete instance '${instanceId}'.`,
    outcome.cause,
  );
}

/**
 * The refusal an allocation gets when a teardown took its lease while the create ran. The caller passes the
 * disposal's outcome rather than reading the owner, so this answers with what that teardown came to —
 * including a delete Limrun did not confirm, which the refused caller is the last route left to hear about.
 */
export function allocationRefusedForTake(
  lease: DeviceLease,
  by: LimrunTeardownRoute,
  outcome: LimrunDisposalOutcome,
): never {
  const { instanceId } = outcome;
  // The hint says what the disposal actually confirmed: an unconfirmed delete leaves the instance possibly
  // still billing, and that caller is the last route left that will hear about it.
  const ended =
    instanceId === undefined
      ? undefined
      : outcome.cleanup === 'uncertain'
        ? `The ${by} of this lease could not confirm instance '${instanceId}' deleted. Release the lease again, or ask Limrun to delete it.`
        : outcome.cleanup === 'attached'
          ? `Instance '${instanceId}' is the caller's own attached instance and was left running. Open a new lease.`
          : `Instance '${instanceId}' was ended by the ${by} of this lease. Open a new lease.`;
  throw new AppError(
    'DEVICE_IN_USE',
    `Limrun lease '${lease.leaseId}' was released while its instance was being prepared`,
    {
      reason: 'limrun_lease_released_mid_allocation',
      ...(instanceId === undefined
        ? { hint: `Instance create for lease '${lease.leaseId}' may still rent one. Check Limrun.` }
        : { limrunInstanceId: instanceId, ...(ended === undefined ? {} : { hint: ended }) }),
      ...(outcome.cleanup === 'uncertain'
        ? { retriable: true, ...(outcome.failure === undefined ? {} : { cause: outcome.failure }) }
        : {}),
    },
    outcome.cause,
  );
}

/**
 * What an allocation reports when the create it waited on failed and left an instance running. The hint names
 * the instance when the create got as far as renting one, and the lease when it did not.
 */
export function createLeftInstanceRunning(
  lease: DeviceLease,
  outcome: LimrunDisposalOutcome,
  createError: unknown,
): never {
  const { instanceId } = outcome;
  return throwUnconfirmedDelete(
    `Limrun lease '${lease.leaseId}' could not be allocated, and its instance could not be deleted`,
    instanceId === undefined ? {} : { limrunInstanceId: instanceId },
    // Both refusals belong to this one answer: why the allocation failed, and why its instance is still
    // billed. The delete's text leads the report because it is what the operator still has to settle.
    joinFailureText(
      outcome.failure,
      createError === undefined ? undefined : `create failed: ${errorMessage(createError)}`,
    ),
    instanceId === undefined
      ? `Ask Limrun what lease '${lease.leaseId}' rented — this runtime could not name the instance.`
      : `Ask Limrun to delete instance '${instanceId}' — this runtime could not confirm the delete.`,
    outcome.cause ?? createError,
  );
}

/** Two reasons one report carries, delete first, when both exist. */
function joinFailureText(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (first === undefined) return second;
  return second === undefined ? first : `${first}; ${second}`;
}

/**
 * The refusal every route that could not confirm an instance delete raises. The instance ids go into details,
 * why the delete failed goes into `details.cause` as text, and the delete's own error goes where a cause
 * renders — the error's own cause. Each caller names its instances the way its own report reads: a single
 * lease its one id, a close the list of what it left.
 */
function throwUnconfirmedDelete(
  message: string,
  instanceDetails: Readonly<Record<string, unknown>>,
  failure: string | undefined,
  hint: string,
  cause: unknown,
): never {
  throw new AppError(
    'COMMAND_FAILED',
    message,
    {
      reason: 'limrun_instance_delete_unconfirmed',
      retriable: true,
      ...instanceDetails,
      ...(failure === undefined ? {} : { cause: failure }),
      hint,
    },
    cause,
  );
}

/**
 * What a daemon close reports for every lease it could not confirm ended. A lease whose create never named an
 * instance is counted the same as one whose delete was refused: this process moved on without stopping it, and
 * the operator needs both the count and the reason.
 */
export function cleanupLeftInstancesRunning(outcomes: readonly LimrunDisposalOutcome[]): never {
  const known = outcomes.map((outcome) => outcome.instanceId).filter((id) => id !== undefined);
  const plural = outcomes.length === 1 ? '' : 's';
  // Why every lease this close could not end, not only the first: each failure is a separate thing the
  // operator may have to name to Limrun.
  return throwUnconfirmedDelete(
    `Limrun cleanup left ${String(outcomes.length)} lease${plural} unended, ${String(known.length)} with a known instance`,
    { limrunInstanceIds: known },
    joinFailureReasons(outcomes),
    known.length === 0 ? unendedLeaseHint(outcomes) : `Ask Limrun to delete: ${known.join(', ')}.`,
    outcomes.find((outcome) => outcome.cause !== undefined)?.cause,
  );
}

/** Every lease this close could not end, with why, joined for one report. */
function joinFailureReasons(outcomes: readonly LimrunDisposalOutcome[]): string | undefined {
  if (outcomes.every((outcome) => outcome.failure === undefined)) return undefined;
  return outcomes.map((outcome) => outcome.failure ?? 'an unconfirmed delete').join('; ');
}

/** What a close says when the work it could not finish has no instance to name yet: the lease and the work. */
function unendedLeaseHint(outcomes: readonly LimrunDisposalOutcome[]): string {
  return `Limrun may still bill work this runtime could not name: ${outcomes
    .map((outcome) => outcome.failure ?? 'an unconfirmed delete')
    .join('; ')}.`;
}
