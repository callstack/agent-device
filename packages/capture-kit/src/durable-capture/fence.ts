import { AppError } from '@agent-device/kernel/errors';
import type {
  DurableResourceEnvelope,
  DurableResourceLifecycleState,
} from '@agent-device/contracts/durable-resource-envelope';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { DurableCaptureResourceStore } from './store.ts';

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
 * a lease, so it cannot reach native or destructive work, and answers from `onCompleted` instead. A
 * transition inside a run that committed its record is refused the same way, which is what keeps a
 * late progress write from reopening an export that is already served.
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
    const record = params.store.read(params.resourcePath);
    if (record.status !== 'decoded') {
      throw fenceError(
        params.store,
        record.status === 'missing'
          ? `${params.store.displayName} resource record is missing`
          : `${params.store.displayName} resource record is unreattachable: ${record.message}`,
      );
    }
    if (!sameFence(record.envelope.fence, params.expected)) {
      throw fenceError(
        params.store,
        `${params.store.displayName} resource ownership fence was lost`,
      );
    }
    if (record.envelope.lifecycle === 'completed') {
      return await params.onCompleted({ envelope: record.envelope });
    }
    let current = record.envelope;
    return await params.run({
      get envelope() {
        return current;
      },
      transition(lifecycle, update = {}) {
        if (current.lifecycle === 'completed') throw completedDurableCaptureError(params.store);
        current = Object.freeze({
          ...current,
          lifecycle,
          ...(update.descriptor === undefined ? {} : { descriptor: update.descriptor }),
          ...(update.metadata === undefined ? {} : { metadata: update.metadata }),
        });
        params.store.write(params.resourcePath, current);
        return current;
      },
    });
  });
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
