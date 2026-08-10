import { AppError } from '@agent-device/kernel/errors';
import type {
  DurableResourceEnvelope,
  DurableResourceLifecycleState,
  ResourceOwnershipFence,
} from '@agent-device/contracts/platform';
import type { DurableCaptureResourceStore } from './durable-capture-resource-store.ts';

const resourceFenceTails = new Map<string, Promise<void>>();

export type DurableCaptureResourceFenceLease<K extends string> = Readonly<{
  envelope: DurableResourceEnvelope<K>;
  transition(
    lifecycle: DurableResourceLifecycleState,
    update?: Readonly<{
      descriptor?: DurableResourceEnvelope<K>['descriptor'];
      metadata?: DurableResourceEnvelope<K>['metadata'];
    }>,
  ): DurableResourceEnvelope<K>;
}>;

/** Holds one persisted ownership fence from validation through side effect and transition. */
export async function withDurableCaptureResourceFence<K extends string, Result>(
  params: Readonly<{
    store: DurableCaptureResourceStore<K>;
    resourcePath: string;
    expected: ResourceOwnershipFence;
    run(lease: DurableCaptureResourceFenceLease<K>): Promise<Result>;
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
    let current = record.envelope;
    return await params.run({
      get envelope() {
        return current;
      },
      transition(lifecycle, update = {}) {
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
