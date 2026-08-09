import { AppError } from '@agent-device/kernel/errors';
import type {
  DurableResourceEnvelope,
  DurableResourceLifecycleState,
  ResourceOwnershipFence,
} from '@agent-device/contracts/platform';
import { readAppLogResourceRecord, writeAppLogResourceRecord } from './app-log-resource-store.ts';

const resourceFenceTails = new Map<string, Promise<void>>();

export type AppLogResourceFenceLease = Readonly<{
  envelope: DurableResourceEnvelope<'app-log'>;
  transition(
    lifecycle: DurableResourceLifecycleState,
    update?: Readonly<{
      descriptor?: DurableResourceEnvelope<'app-log'>['descriptor'];
      metadata?: DurableResourceEnvelope<'app-log'>['metadata'];
    }>,
  ): DurableResourceEnvelope<'app-log'>;
}>;

/**
 * Serializes one app-log resource from persisted fence validation through the
 * native side effect and its persisted transition. Production invokes this
 * only while the process owns the daemon lock; the per-record queue supplies
 * the narrower request/startup mutual exclusion inside that owner.
 */
export async function withAppLogResourceFence<T>(params: {
  resourcePath: string;
  expected: ResourceOwnershipFence;
  run(lease: AppLogResourceFenceLease): Promise<T>;
}): Promise<T> {
  return await serializeResource(params.resourcePath, async () => {
    const record = readAppLogResourceRecord(params.resourcePath);
    if (record.status !== 'decoded') {
      throw resourceFenceError(
        record.status === 'missing'
          ? 'App-log resource record is missing'
          : `App-log resource record is unreattachable: ${record.message}`,
      );
    }
    if (!sameFence(record.envelope.fence, params.expected)) {
      throw resourceFenceError('App-log resource ownership fence was lost');
    }

    let current = record.envelope;
    return await params.run({
      get envelope() {
        return current;
      },
      transition: (lifecycle, update = {}) => {
        current = Object.freeze({
          ...current,
          lifecycle,
          ...(update.descriptor === undefined ? {} : { descriptor: update.descriptor }),
          ...(update.metadata === undefined ? {} : { metadata: update.metadata }),
        });
        writeAppLogResourceRecord(params.resourcePath, current);
        return current;
      },
    });
  });
}

function sameFence(left: ResourceOwnershipFence, right: ResourceOwnershipFence): boolean {
  return left.token === right.token && left.generation === right.generation;
}

async function serializeResource<T>(resourcePath: string, task: () => Promise<T>): Promise<T> {
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

function resourceFenceError(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'ownership-fence-lost',
    retriable: false,
    hint: 'Use the current app-log resource owner or retain the recovery record for manual recovery.',
  });
}
