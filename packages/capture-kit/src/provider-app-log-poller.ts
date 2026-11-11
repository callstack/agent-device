import type {
  AppLogLiveHandle,
  AppLogLiveSnapshot,
  AppLogOutputSink,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import { AsyncCleanupStack } from '@agent-device/contracts/async-lifecycle';
import type { FinishOutcome } from '@agent-device/contracts/durable-resource';
import type { LogBackend } from '@agent-device/contracts/observability';
import { createAppLogLiveHandleFromFinish } from './app-log-live-handle.ts';

const EXISTING_TAIL_BYTES = 256 * 1024;
const POLL_INTERVAL_MS = 1_000;
const READ_TIMEOUT_MS = 5_000;
const READ_LINE_LIMIT = 1_000;

export type ProviderAppLogReader = AsyncDisposable &
  Readonly<{
    /**
     * Returns the provider's current log tail. A reader may ignore `signal`: the poller abandons a
     * read that outlives its budget without waiting for the provider request to end.
     */
    readLogs(appBundleId: string, lineLimit: number, signal: AbortSignal): Promise<string>;
  }>;

export type ProviderAppLogPollerOptions = Readonly<{
  host: Pick<AppLogRuntimeHost, 'outputs' | 'clock'>;
  /** Names the provider in cleanup messages. */
  provider: string;
  backend: LogBackend;
  reader: ProviderAppLogReader;
  appBundleId: string;
  outputPath: string;
}>;

/** Takes ownership of `reader`: it is disposed on acquisition failure or when the poll finishes. */
export async function startProviderAppLogPoller(
  options: ProviderAppLogPollerOptions,
): Promise<AppLogLiveHandle> {
  const rollback = new AsyncCleanupStack();
  let adopted = false;
  rollback.defer(async () => {
    if (!adopted) await options.reader[Symbol.asyncDispose]();
  });
  try {
    const existingTail = await options.host.outputs.readTail(
      options.outputPath,
      EXISTING_TAIL_BYTES,
    );
    const output = await options.host.outputs.openAppend(options.outputPath);
    rollback.defer(async () => {
      if (!adopted) await output[Symbol.asyncDispose]();
    });
    const handle = createPollerHandle(options, output, remoteOnlyTail(existingTail));
    adopted = true;
    return handle;
  } finally {
    await rollback[Symbol.asyncDispose]();
  }
}

function createPollerHandle(
  options: ProviderAppLogPollerOptions,
  output: AppLogOutputSink,
  existingTail: string,
): AppLogLiveHandle {
  const { backend, host } = options;
  const startedAt = host.clock.now();
  let state: AppLogLiveSnapshot['state'] = 'active';
  const stop = new AbortController();
  let previous = existingTail;
  // A read abandoned at its budget may still be running in the provider. No second read starts,
  // and the reader is not disposed, until it settles.
  let inFlight: Promise<void> | undefined;
  const startRead = () => {
    const attempt = boundedRead(options, stop.signal);
    const settled: Promise<void> = attempt.settled.then(() => {
      if (inFlight === settled) inFlight = undefined;
    });
    inFlight = settled;
    return attempt.outcome;
  };
  const pollOnce = async (): Promise<AppLogLiveSnapshot['state']> => {
    if (inFlight) return 'recovering';
    const read = await startRead();
    // A slow provider read is transient like a failed one: retry on the next tick.
    if (read.status === 'timeout' || stop.signal.aborted) return 'recovering';
    const delta = appendedTail(previous, read.text);
    if (delta) await output.write(delta.endsWith('\n') ? delta : `${delta}\n`);
    previous = read.text;
    return 'active';
  };
  const polling = (async () => {
    while (!stop.signal.aborted) {
      const next = await pollOnce().catch(() => 'recovering' as const);
      if (stop.signal.aborted) return;
      state = next;
      await host.clock.sleep(POLL_INTERVAL_MS, stop.signal).catch(() => undefined);
    }
  })();
  const pendingDisposals = new Set<AsyncDisposable>([options.reader, output]);
  let finishPromise:
    | Promise<FinishOutcome<{ backend: LogBackend; outputPath: string; completedAt: number }>>
    | undefined;
  const finish = async () =>
    (finishPromise ??= (async () => {
      stop.abort();
      await polling;
      const readSettled = await settledWithin(inFlight, host, READ_TIMEOUT_MS);
      // A reader whose read never settled stays owned; a later finish or dispose retries it.
      const failures = await disposeAll(pendingDisposals, readSettled ? undefined : options.reader);
      if (!readSettled) failures.push(new Error('provider read still in flight'));
      if (failures.length > 0) {
        finishPromise = undefined;
        state = 'failed';
        return {
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: `${options.provider} app-log cleanup did not settle every owned resource`,
        } as const;
      }
      state = 'ended';
      return {
        status: 'completed',
        result: { backend, outputPath: options.outputPath, completedAt: host.clock.now() },
      } as const;
    })());
  return createAppLogLiveHandleFromFinish({
    inspect: () => ({ backend, state, startedAt }),
    finish,
  });
}

async function settledWithin(
  pending: Promise<void> | undefined,
  host: ProviderAppLogPollerOptions['host'],
  budgetMs: number,
): Promise<boolean> {
  if (!pending) return true;
  const grace = new AbortController();
  try {
    return await Promise.race([
      pending.then(() => true),
      host.clock.sleep(budgetMs, grace.signal).then(() => false),
    ]);
  } finally {
    grace.abort();
  }
}

/**
 * `outcome` settles at the read, its budget, or `stopSignal`, whichever comes first. `settled`
 * settles only when the provider call itself does, so a caller can wait out an abandoned read.
 */
function boundedRead(
  options: ProviderAppLogPollerOptions,
  stopSignal: AbortSignal,
): Readonly<{
  outcome: Promise<Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'timeout' }>>;
  settled: Promise<void>;
}> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, stopSignal]);
  const read = options.reader
    .readLogs(options.appBundleId, READ_LINE_LIMIT, signal)
    .then((text) => ({ status: 'read' as const, text }));
  const settled = read.then(
    () => undefined,
    () => undefined,
  );
  const outcome = Promise.race([
    read,
    options.host.clock.sleep(READ_TIMEOUT_MS, signal).then(() => ({ status: 'timeout' as const })),
  ]).finally(() => controller.abort());
  return { outcome, settled };
}

/** The new tail minus its longest overlap with the previous tail's suffix. */
function appendedTail(previous: string, current: string): string {
  if (!previous || !current) return current;
  const prefix = buildPrefixTable(current);
  const maximum = Math.min(previous.length, current.length);
  const suffix = previous.slice(previous.length - maximum);
  return current.slice(suffixPrefixOverlap(suffix, current, prefix));
}

function buildPrefixTable(text: string): Uint32Array {
  const prefix = new Uint32Array(text.length);
  let matched = 0;
  for (let index = 1; index < text.length; index += 1) {
    while (matched > 0 && text[index] !== text[matched]) matched = prefix[matched - 1]!;
    if (text[index] === text[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

function suffixPrefixOverlap(suffix: string, current: string, prefix: Uint32Array): number {
  let matched = 0;
  for (let index = 0; index < suffix.length; index += 1) {
    while (matched > 0 && suffix[index] !== current[matched]) matched = prefix[matched - 1]!;
    if (suffix[index] === current[matched]) matched += 1;
    if (matched === current.length && index < suffix.length - 1) matched = prefix[matched - 1]!;
  }
  return matched;
}

function remoteOnlyTail(tail: string): string {
  return tail
    .split('\n')
    .filter((line) => !line.startsWith('[agent-device][mark]'))
    .join('\n');
}

async function disposeAll(
  resources: Set<AsyncDisposable>,
  retained?: AsyncDisposable,
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    [...resources]
      .filter((resource) => resource !== retained)
      .map(async (resource) => {
        await resource[Symbol.asyncDispose]();
        resources.delete(resource);
      }),
  );
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}
