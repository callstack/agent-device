import type {
  AppLogLiveHandle,
  AppLogLiveSnapshot,
  AppLogOutputSink,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import type { FinishOutcome } from '@agent-device/contracts/durable-resource';
import type { LogBackend } from '@agent-device/contracts/observability';
import { AsyncCleanupStack } from '@agent-device/contracts/async-lifecycle';
import { createAppLogLiveHandleFromFinish } from './app-log-live-handle.ts';

const READ_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const READ_LINE_LIMIT = 1_000;
const TAIL_READ_BYTES = 256 * 1024;
const MARK_PREFIX = '[agent-device][mark]';
const READ_ABORT_MESSAGE = 'App-log provider read aborted';

/**
 * Provider-supplied app-log source. A read cannot be cancelled, so the poller settles a bounded
 * read on its own timeout and never proves that the provider request ended.
 */
export type AppLogPollerReader = AsyncDisposable &
  Readonly<{
    readLogs(appBundleId: string, lineLimit: number): Promise<string>;
  }>;

export type AppLogPollerInput = Readonly<{
  host: AppLogRuntimeHost;
  reader: AppLogPollerReader;
  backend: LogBackend;
  appBundleId: string;
  outputPath: string;
  cleanupFailureMessage: string;
}>;

export async function startAppLogPoller(input: AppLogPollerInput): Promise<AppLogLiveHandle> {
  const rollback = new AsyncCleanupStack();
  let adopted = false;
  rollback.defer(async () => {
    if (!adopted) await input.reader[Symbol.asyncDispose]();
  });
  try {
    const existingTail = await input.host.outputs.readTail(input.outputPath, TAIL_READ_BYTES);
    const output = await input.host.outputs.openAppend(input.outputPath);
    rollback.defer(async () => {
      if (!adopted) await output[Symbol.asyncDispose]();
    });
    const handle = createPollerHandle(input, output, remoteOnlyTail(existingTail));
    adopted = true;
    return handle;
  } finally {
    await rollback[Symbol.asyncDispose]();
  }
}

function createPollerHandle(
  input: AppLogPollerInput,
  output: AppLogOutputSink,
  existingTail: string,
): AppLogLiveHandle {
  const { backend } = input;
  const startedAt = input.host.clock.now();
  let state: AppLogLiveSnapshot['state'] = 'active';
  let stopped = false;
  let previous = existingTail;
  const polling = (async () => {
    while (!stopped) {
      try {
        const read = await boundedRead(input);
        if (read.status === 'timeout') {
          state = 'failed';
          return;
        }
        if (stopped) return;
        const delta = appendedTail(previous, read.text);
        previous = read.text;
        if (delta) await output.write(delta.endsWith('\n') ? delta : `${delta}\n`);
        state = 'active';
      } catch {
        if (stopped) return;
        state = 'recovering';
      }
      await input.host.clock.sleep(POLL_INTERVAL_MS);
    }
  })();
  let finishPromise:
    | Promise<FinishOutcome<{ backend: LogBackend; outputPath: string; completedAt: number }>>
    | undefined;
  const finish = async () =>
    (finishPromise ??= (async () => {
      stopped = true;
      await polling;
      const failures = await disposeAll([input.reader, output]);
      if (failures.length > 0) {
        state = 'failed';
        return {
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: input.cleanupFailureMessage,
        } as const;
      }
      state = 'ended';
      return {
        status: 'completed',
        result: {
          backend,
          outputPath: input.outputPath,
          completedAt: input.host.clock.now(),
        },
      } as const;
    })());
  return createAppLogLiveHandleFromFinish({
    inspect: () => ({ backend, state, startedAt }),
    finish,
  });
}

async function boundedRead(
  input: AppLogPollerInput,
): Promise<Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'timeout' }>> {
  const controller = new AbortController();
  const read = settleOnAbort(
    input.reader.readLogs(input.appBundleId, READ_LINE_LIMIT),
    controller.signal,
  ).then((text) => ({ status: 'read' as const, text }));
  try {
    const result = await Promise.race([
      read,
      input.host.clock
        .sleep(READ_TIMEOUT_MS, controller.signal)
        .then(() => ({ status: 'timeout' as const })),
    ]);
    if (result.status === 'timeout') {
      controller.abort();
      await read.catch(() => undefined);
    }
    return result;
  } finally {
    controller.abort();
  }
}

/** A reader that cannot cancel its request must still let the bounded read settle on abort. */
async function settleOnAbort<Value>(source: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return await new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error(READ_ABORT_MESSAGE));
    if (signal.aborted) {
      void source.catch(() => undefined);
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    void source.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

/** The new tail minus its overlap with the previous one (longest suffix/prefix match). */
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
    .filter((line) => !line.startsWith(MARK_PREFIX))
    .join('\n');
}

async function disposeAll(resources: readonly AsyncDisposable[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    resources.map(async (resource) => await resource[Symbol.asyncDispose]()),
  );
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}
