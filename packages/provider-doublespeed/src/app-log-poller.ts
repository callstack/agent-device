import type {
  AppLogLiveHandle,
  AppLogLiveSnapshot,
  AppLogOutputSink,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import type { FinishOutcome } from '@agent-device/contracts/durable-resource';
import { AsyncCleanupStack } from '@agent-device/contracts/async-lifecycle';
import { createAppLogLiveHandleFromFinish } from '@agent-device/capture-kit';
import type { LogBackend } from '@agent-device/contracts/observability';

const APP_LOG_BACKEND: LogBackend = 'ios-simulator';
const READ_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const READ_LINE_LIMIT = 1_000;

export type DoublespeedAppLogReader = AsyncDisposable &
  Readonly<{
    leaseId: string;
    simulatorId: string;
    readLogs(appBundleId: string, lineLimit: number, signal?: AbortSignal): Promise<string>;
  }>;

export async function startDoublespeedAppLogPoller(options: {
  host: AppLogRuntimeHost;
  reader: DoublespeedAppLogReader;
  appBundleId: string;
  outputPath: string;
}): Promise<AppLogLiveHandle> {
  const rollback = new AsyncCleanupStack();
  let adopted = false;
  rollback.defer(async () => {
    if (!adopted) await options.reader[Symbol.asyncDispose]();
  });
  try {
    const existingTail = await options.host.outputs.readTail(options.outputPath, 256 * 1024);
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
  options: {
    host: AppLogRuntimeHost;
    reader: DoublespeedAppLogReader;
    appBundleId: string;
    outputPath: string;
  },
  output: AppLogOutputSink,
  existingTail: string,
): AppLogLiveHandle {
  const startedAt = options.host.clock.now();
  let state: AppLogLiveSnapshot['state'] = 'active';
  let stopped = false;
  let previous = existingTail;
  const polling = (async () => {
    while (!stopped) {
      try {
        const read = await boundedRead(options);
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
      await options.host.clock.sleep(POLL_INTERVAL_MS);
    }
  })();
  let finishPromise:
    | Promise<FinishOutcome<{ backend: LogBackend; outputPath: string; completedAt: number }>>
    | undefined;
  const finish = async () =>
    (finishPromise ??= (async () => {
      stopped = true;
      await polling;
      const failures = await disposeAll([options.reader, output]);
      if (failures.length > 0) {
        state = 'failed';
        return {
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: 'Doublespeed app-log cleanup did not settle every owned resource',
        } as const;
      }
      state = 'ended';
      return {
        status: 'completed',
        result: {
          backend: APP_LOG_BACKEND,
          outputPath: options.outputPath,
          completedAt: options.host.clock.now(),
        },
      } as const;
    })());
  return createAppLogLiveHandleFromFinish({
    inspect: () => ({ backend: APP_LOG_BACKEND, state, startedAt }),
    finish,
  });
}

async function boundedRead(options: {
  host: AppLogRuntimeHost;
  reader: DoublespeedAppLogReader;
  appBundleId: string;
}): Promise<Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'timeout' }>> {
  const controller = new AbortController();
  const read = settleOnAbort(
    options.reader.readLogs(options.appBundleId, READ_LINE_LIMIT, controller.signal),
    controller.signal,
  ).then((text) => ({ status: 'read' as const, text }));
  try {
    const result = await Promise.race([
      read,
      options.host.clock
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

/** A reader that ignores its signal must still let the bounded read settle on abort. */
async function settleOnAbort<Value>(source: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return await new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('App-log provider read aborted'));
    if (signal.aborted) {
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
    .filter((line) => !line.startsWith('[agent-device][mark]'))
    .join('\n');
}

async function disposeAll(resources: readonly AsyncDisposable[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    resources.map(async (resource) => await resource[Symbol.asyncDispose]()),
  );
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}
