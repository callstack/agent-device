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
        if (delta) await output.write(delta.endsWith('\n') ? delta : `${delta}\n`);
        previous = read.text;
        state = 'active';
      } catch {
        if (stopped) return;
        state = 'recovering';
      }
      await host.clock.sleep(POLL_INTERVAL_MS);
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

async function boundedRead(
  options: ProviderAppLogPollerOptions,
): Promise<Readonly<{ status: 'read'; text: string }> | Readonly<{ status: 'timeout' }>> {
  const controller = new AbortController();
  const read = options.reader.readLogs(options.appBundleId, READ_LINE_LIMIT, controller.signal);
  try {
    return await Promise.race([
      read.then((text) => ({ status: 'read' as const, text })),
      options.host.clock
        .sleep(READ_TIMEOUT_MS, controller.signal)
        .then(() => ({ status: 'timeout' as const })),
    ]);
  } finally {
    controller.abort();
  }
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

async function disposeAll(resources: readonly AsyncDisposable[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    resources.map(async (resource) => await resource[Symbol.asyncDispose]()),
  );
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}
