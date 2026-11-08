import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import type { ProviderAppLogReader } from '@agent-device/capture-kit/provider-app-log';
import type { LogStream } from '@limrun/api/ios-client';

const MAX_LOG_BYTES = 1024 * 1024;

/** Keeps app console and filtered unified logs in one bounded tail for the shared log collector. */
export function createLimrunIosAppLogReader(
  input: Parameters<LimrunRuntimeDependencies['ios']['createAppLogReader']>[0],
): ProviderAppLogReader {
  const lifetime = new AbortController();
  let active: { app: string; controller: AbortController; streams: LogStream[] } | undefined;
  const metadataReads = new Set<Promise<void>>();
  let activeApp: string | undefined;
  let failure: Error | undefined;
  const lines: string[] = [];
  let bytes = 0;
  const append = (line: string) => {
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    while (bytes > MAX_LOG_BYTES && lines.length) bytes -= Buffer.byteLength(lines.shift()!) + 1;
  };
  const stop = () => {
    const owned = active;
    active = undefined;
    owned?.controller.abort();
    for (const stream of owned?.streams ?? []) stream.stop();
  };
  const start = (app: string) => {
    const owned = { app, controller: new AbortController(), streams: [] as LogStream[] };
    active = owned;
    const signal = AbortSignal.any([lifetime.signal, owned.controller.signal]);
    const consoleStream = input.client.streamAppLog(app);
    owned.streams.push(consoleStream);
    const systemStream = input.client.streamSyslog();
    owned.streams.push(systemStream);
    let executable: string | undefined;
    let metadataReady = false;
    const pendingLines: string[] = [];
    let pendingBytes = 0;
    consoleStream.on('line', (line) => {
      if (active === owned) append(line);
    });
    systemStream.on('line', (line) => {
      if (active !== owned) return;
      if (metadataReady) {
        if (matchesAppleLogTarget(line, app, executable)) append(line);
      } else {
        pendingLines.push(line);
        pendingBytes += Buffer.byteLength(line) + 1;
        while (pendingBytes > MAX_LOG_BYTES && pendingLines.length)
          pendingBytes -= Buffer.byteLength(pendingLines.shift()!) + 1;
      }
    });
    for (const stream of owned.streams) {
      stream.on('error', (error) => {
        if (active === owned) failure = error;
      });
      stream.on('close', () => {
        if (!lifetime.signal.aborted && active === owned)
          failure = new Error('Limrun log stream closed');
      });
    }
    // Metadata can outlive a short poll, but never the app's streams or the reader.
    const pending = (async () => {
      try {
        const { readLimrunAppInfo } = await import('./limrun-ios-files.ts');
        const info = await readLimrunAppInfo(input, app, signal);
        if (active !== owned) return;
        executable =
          typeof info?.CFBundleExecutable === 'string' ? info.CFBundleExecutable : undefined;
        metadataReady = true;
        for (const line of pendingLines)
          if (matchesAppleLogTarget(line, app, executable)) append(line);
      } catch (error) {
        if (!signal.aborted && active === owned)
          failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        pendingLines.length = 0;
      }
    })();
    metadataReads.add(pending);
    void pending.finally(() => metadataReads.delete(pending));
  };
  return {
    readLogs: async (app, limit, signal) => {
      const bounded = AbortSignal.any([lifetime.signal, signal]);
      bounded.throwIfAborted();
      if (failure) {
        const error = failure;
        failure = undefined;
        stop();
        throw error;
      }
      if (active?.app !== app) {
        stop();
        if (activeApp !== app) {
          lines.length = 0;
          bytes = 0;
          activeApp = app;
        }
        try {
          // Read retained console history before subscribing; restarting the collector must not lose it.
          const history = await awaitWithSignal(input.client.appLogTail(app, limit), bounded);
          lines.length = 0;
          bytes = 0;
          for (const line of history.split('\n')) if (line) append(line);
          start(app);
        } catch (error) {
          stop();
          throw error;
        }
      }
      return lines.slice(-limit).join('\n');
    },
    [Symbol.asyncDispose]: async () => {
      lifetime.abort();
      stop();
      await Promise.all(metadataReads);
    },
  };
}

/** Matches the fields retained by a formatted simulator log stream. */
function matchesAppleLogTarget(
  line: string,
  appBundleId: string,
  executableName?: string,
): boolean {
  const record =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \S+ (.+?)\[\d+(?::[^\]]+)?\](?: \(([^)]*)\))?/.exec(
      line,
    );
  if (!record) return false;
  const [, process, subsystem] = record;
  return (
    subsystem === appBundleId ||
    subsystem?.startsWith(`${appBundleId}.`) === true ||
    process === executableName ||
    process?.toLowerCase() === appBundleId.toLowerCase()
  );
}
