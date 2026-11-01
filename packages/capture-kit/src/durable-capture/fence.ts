import { AppError } from '@agent-device/kernel/errors';
import type {
  DurableResourceEnvelope,
  DurableResourceLifecycleState,
} from '@agent-device/contracts/durable-resource-envelope';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { DurableCaptureResourceRecord, DurableCaptureResourceStore } from './store.ts';

const resourceFenceTails = new Map<string, Promise<void>>();

/** The lease over a record this fence found open; it is the only way a run may write that record. */
export type DurableCaptureOpenResourceFenceLease<K extends string> = Readonly<{
  envelope: DurableResourceEnvelope<K>;
  transition(
    lifecycle: DurableResourceLifecycleState,
    update?: Readonly<{
      descriptor?: DurableResourceEnvelope<K>['descriptor'];
      metadata?: DurableResourceEnvelope<K>['metadata'];
    }>,
  ): DurableResourceEnvelope<K>;
}>;

/** The facts of a record this fence found committed. A terminal record is read, never written. */
export type DurableCaptureCompletedResourceFenceLease<K extends string> = Readonly<{
  envelope: DurableResourceEnvelope<K>;
}>;

/**
 * Holds one persisted ownership fence from validation through side effect and transition.
 *
 * Fence equality proves ownership, never admission: two callers that captured the same live resource
 * present the same fence, so serialization alone would let a queued attempt drive a record another
 * attempt already committed. This is the one owner of that rule. While it holds the fence it reads
 * the record's lifecycle, and a `completed` record is terminal — a run that finds one never receives
 * a lease, so it cannot reach native or destructive work, and answers from `onCompleted` instead.
 *
 * Admission is re-checked at every write, not only at lease issue. A run can hand its lease or its
 * progress port to something that outlives it, so a transition re-reads the persisted record and
 * publishes onto that: a lease whose own run has ended, one that finds the fence gone, and one that
 * finds the record committed are each refused before publication. That is what keeps an escaped
 * progress or completion write from overwriting the outcome another run committed.
 */
export async function withDurableCaptureResourceFence<K extends string, Result>(
  params: Readonly<{
    store: DurableCaptureResourceStore<K>;
    resourcePath: string;
    expected: ResourceOwnershipFence;
    /** Answers a run whose record this fence found committed, before any of the run's work. */
    onCompleted(lease: DurableCaptureCompletedResourceFenceLease<K>): Result | Promise<Result>;
    run(lease: DurableCaptureOpenResourceFenceLease<K>): Promise<Result>;
  }>,
): Promise<Result> {
  return await serializeResource(params.resourcePath, async () => {
    const admitted = requireAdmissibleRecord(params.store, params.resourcePath, params.expected);
    if (admitted.envelope.lifecycle === 'completed') {
      return await params.onCompleted({ envelope: admitted.envelope });
    }
    let current = admitted.envelope;
    // The lease is the run's, for as long as that run is the one holding the fence.
    let issued = true;
    try {
      return await params.run({
        get envelope() {
          return current;
        },
        transition(lifecycle, update = {}) {
          // The persisted record decides, so a lease cannot publish from a view its own run cached.
          const persisted = requireAdmissibleRecord(
            params.store,
            params.resourcePath,
            params.expected,
          );
          if (persisted.envelope.lifecycle === 'completed') {
            throw completedDurableCaptureError(params.store);
          }
          if (!issued) throw releasedLeaseError(params.store);
          current = Object.freeze({
            ...persisted.envelope,
            lifecycle,
            ...(update.descriptor === undefined ? {} : { descriptor: update.descriptor }),
            ...(update.metadata === undefined ? {} : { metadata: update.metadata }),
          });
          params.store.write(params.resourcePath, current);
          return current;
        },
      });
    } finally {
      issued = false;
    }
  });
}

/** The record this caller still owns, refusing a record it no longer holds a fence over. */
function requireAdmissibleRecord<K extends string>(
  store: DurableCaptureResourceStore<K>,
  resourcePath: string,
  expected: ResourceOwnershipFence,
): Extract<DurableCaptureResourceRecord<K>, { status: 'decoded' }> {
  const record = store.read(resourcePath);
  if (record.status !== 'decoded') {
    throw fenceError(
      store,
      record.status === 'missing'
        ? `${store.displayName} resource record is missing`
        : `${store.displayName} resource record is unreattachable: ${record.message}`,
    );
  }
  if (!sameFence(record.envelope.fence, expected)) {
    throw fenceError(store, `${store.displayName} resource ownership fence was lost`);
  }
  return record;
}

function sameFence(left: ResourceOwnershipFence, right: ResourceOwnershipFence): boolean {
  return left.token === right.token && left.generation === right.generation;
}

async function serializeResource<Result>(
  resourcePath: string,
  task: () => Promise<Result>,
): Promise<Result> {
  const previous = resourceFenceTails.get(resourcePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  resourceFenceTails.set(resourcePath, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (resourceFenceTails.get(resourcePath) === tail) resourceFenceTails.delete(resourcePath);
  }
}

function fenceError(store: DurableCaptureResourceStore<string>, message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'ownership-fence-lost',
    retriable: false,
    hint: `Use the current ${store.displayName.toLowerCase()} resource owner or retain the recovery record for manual recovery.`,
  });
}

/**
 * The refusal a lease gives once the run it was issued to has ended. The caller no longer holds the
 * record, whatever its cached view says, so the reason is the one a lost fence already publishes.
 */
function releasedLeaseError(store: DurableCaptureResourceStore<string>): AppError {
  return fenceError(store, `${store.displayName} resource fence was released with its run`);
}

/**
 * Whether an error is the refusal a terminal record gives. A caller releasing a resource treats it as
 * settled: the record is committed, so the resource is released, whatever the record could replay.
 */
export function isCompletedDurableCaptureError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'resource-already-completed';
}

/**
 * The refusal a caller gives when its work arrived after the record committed. The reason lives here
 * with the rule that produces it, so a finish, a cleanup and a late progress write cannot disagree
 * about what a terminal record answers.
 */
export function completedDurableCaptureError(store: DurableCaptureResourceStore<string>): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${store.displayName} resource record is already completed`,
    {
      reason: 'resource-already-completed',
      retriable: false,
      hint: `Read the completed ${store.displayName.toLowerCase()} record instead of finishing or cleaning it again.`,
    },
  );
}
