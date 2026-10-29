import { DestinationTunnelHARAssembler } from '@limrun/api/destination-tunnel-har';
import { validateDestinationTunnelSelectors } from '@limrun/api/destination-tunnel';
import { DestinationTunnelSessionError } from '@limrun/api/destination-tunnel-dialer';
import type { DestinationTunnelOpenFailureReason } from '@limrun/api/destination-tunnel';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import type { DestinationTcpTunnel } from '@limrun/api/destination-tunnel-dialer';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Limrun network capture: one destination tunnel with inspection, streamed into a live HAR 1.2
 * file. The file is replaced whole after completed requests, so a reader (jq included) always sees
 * a valid document, during the session and after it. Memory and the cost of each write stay
 * bounded however long the session runs: bodies are cut at `HAR_BODY_LIMIT_BYTES`, and the
 * oldest entries leave the file once it would pass `HAR_MAX_BYTES`.
 *
 * One instance carries one destination tunnel, so the Metro/companion route rides this same
 * tunnel: the default selectors include the `localhost:8081` route, which makes the host's Metro
 * reachable from the device through the tunnel.
 *
 * Known limits: certificate-pinned hosts fail closed against the tunnel's interception, and apps
 * that resolve names over DNS-over-HTTPS bypass the capture entirely. Captured traffic leaves from
 * the daemon host, not from the device's network.
 *
 * Tunnel failures never reach the HAR's readers on their own: the SDK logs dial failures only to
 * the console. The capture therefore records the typed inspection failures (a request the tunnel
 * could not complete, an inspection error, a stream gap) and reads the tunnel's last typed dial
 * failure on demand, so `artifacts` and close can report them.
 */

/** Generic public-TLD wildcards, measured acceptable by Limrun's selector validation. */
export const DEFAULT_LIMRUN_HAR_SELECTORS = Object.freeze([
  '*.com',
  '*.org',
  '*.app',
  '*.net',
  '*.io',
  '*.dev',
  // The Metro/companion route: the device reaches this host's Metro through the one tunnel.
  'localhost:8081',
] as const);

export type LimrunHarTunnelClient = Readonly<{
  startTunnel(options: {
    selectors: string[];
    inspection?: { enabled?: boolean; captureBodies?: boolean; maxBodyBytes?: number };
    onInspectionEvent?: (event: DestinationTunnelInspectionEvent) => void;
    onInspectionError?: (error: Error) => void;
  }): Promise<DestinationTcpTunnel>;
  getTunnelStatus?(): Promise<
    Readonly<{
      lastDialFailure?: Readonly<{
        tunnelId: string;
        selectorId: string;
        reason: DestinationTunnelOpenFailureReason;
        osCode?: string;
      }>;
    }>
  >;
}>;

/**
 * What failed inside the capture:
 * - `request-failed`: the tunnel accepted the device's request but could not complete it, for
 *   example a destination that did not resolve, refused, or timed out. The HAR holds the entry
 *   with status 0.
 * - `inspection-error`: the tunnel could not inspect a connection, usually a certificate-pinned
 *   host that rejected the interception.
 * - `inspection-gap`: the inspection stream skipped events, so the HAR misses requests.
 * - `inspection-stream-error`: the inspection stream itself failed.
 * - `har-write-failed`: the HAR file could not be written, so it lags the captured traffic.
 * - `har-truncated`: the oldest entries left the HAR to keep it under its size cap; the count is
 *   the number of entries dropped.
 */
export type LimrunTunnelFailureKind =
  | 'request-failed'
  | 'inspection-error'
  | 'inspection-gap'
  | 'inspection-stream-error'
  | 'har-write-failed'
  | 'har-truncated';

export type LimrunTunnelFailure = Readonly<{
  at: string;
  host?: string;
  port?: number;
  /** The provider's own description, kept verbatim for a human reader. */
  message: string;
}>;

export type LimrunTunnelFailureReport = Readonly<{
  total: number;
  /**
   * Each kind's count and its most recent failures, oldest first. Kinds are kept apart, so the
   * inspection errors of pinned system hosts cannot push an app's failed requests out.
   */
  byKind: Readonly<
    Partial<
      Record<
        LimrunTunnelFailureKind,
        Readonly<{ count: number; latest: readonly LimrunTunnelFailure[] }>
      >
    >
  >;
  /** The tunnel's most recent dial failure, with the provider's typed reason. */
  lastDialFailure?: Readonly<{
    reason: DestinationTunnelOpenFailureReason;
    osCode?: string;
    selector?: string;
  }>;
}>;

const LATEST_FAILURES_PER_KIND = 5;
const TUNNEL_STATUS_BUDGET_MS = 2_000;
/** Completed requests within this window share one rewrite of the HAR file. */
const HAR_WRITE_COALESCE_MS = 250;
/** Each request and response body is cut to this size, by the tunnel and by the assembler. */
const HAR_BODY_LIMIT_BYTES = 64 * 1024;
/** The serialized entries a HAR file keeps; older entries are dropped first. */
export const HAR_MAX_BYTES = 8 * 1024 * 1024;

export type LimrunHarCapture = Readonly<{
  harPath: string;
  /**
   * Stops inspection and writes the final HAR document. Safe more than once; when the tunnel
   * refuses to close, the HAR is still written and a later call tries the tunnel again.
   */
  close(): Promise<void>;
  /** The failures recorded so far, plus the tunnel's last dial failure while it is open. */
  failures(): Promise<LimrunTunnelFailureReport>;
}>;

export type LimrunHarCaptureFailure = Readonly<{
  reason: 'tunnel-in-use' | 'tunnel-start-failed' | 'capture-dir-unset';
  message: string;
}>;

export type LimrunHarCaptureResult =
  | Readonly<{ ok: true; capture: LimrunHarCapture }>
  | Readonly<{ ok: false } & LimrunHarCaptureFailure>;

/**
 * Opens the instance's destination tunnel with inspection and writes every completed request into
 * `harPath` as a HAR 1.2 document. Bodies are captured; the file holds raw traffic.
 */
export async function startLimrunHarCapture(
  client: LimrunHarTunnelClient,
  input: Readonly<{ harPath: string; selectors?: readonly string[] }>,
): Promise<LimrunHarCaptureResult> {
  const selectors = [...(input.selectors ?? DEFAULT_LIMRUN_HAR_SELECTORS)];
  try {
    validateDestinationTunnelSelectors(selectors);
  } catch (error) {
    return { ok: false, reason: 'tunnel-start-failed', message: describe(error) };
  }
  const failures = createFailureRecorder();
  try {
    // The HAR holds raw traffic, so only the daemon's user may read it.
    await fs.promises.mkdir(path.dirname(input.harPath), { recursive: true, mode: 0o700 });
    const harFile = createHarFile(input.harPath, {
      onDropped: (count) =>
        failures.record(
          'har-truncated',
          { message: `dropped the ${count} oldest entries to stay under ${HAR_MAX_BYTES} bytes` },
          count,
        ),
      onWriteError: (error) => failures.record('har-write-failed', { message: describe(error) }),
    });
    await harFile.flush();
    const assembler = new DestinationTunnelHARAssembler(HAR_BODY_LIMIT_BYTES);
    let closed = false;
    const tunnel = await client.startTunnel({
      selectors,
      inspection: { enabled: true, captureBodies: true, maxBodyBytes: HAR_BODY_LIMIT_BYTES },
      onInspectionEvent: (event) => {
        if (closed) return;
        failures.observe(event);
        const completed = assembler.add(event);
        if (completed && event.type === 'complete') harFile.add(completed);
      },
      onInspectionError: (error) => {
        failures.record('inspection-stream-error', { message: describe(error) });
      },
    });
    return {
      ok: true,
      capture: Object.freeze({
        harPath: input.harPath,
        close: async () => {
          if (closed) return;
          try {
            tunnel.close();
            closed = true;
          } finally {
            await harFile.flush();
          }
        },
        failures: async () =>
          failures.report(
            closed
              ? undefined
              : await readLastDialFailure(client, tunnel.tunnelId, tunnel.selectors),
          ),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof DestinationTunnelSessionError && error.code === 'already_active'
          ? 'tunnel-in-use'
          : 'tunnel-start-failed',
      message: describe(error),
    };
  }
}

function createFailureRecorder() {
  const byKind: Partial<
    Record<LimrunTunnelFailureKind, { count: number; latest: LimrunTunnelFailure[] }>
  > = {};
  let total = 0;
  const record = (
    kind: LimrunTunnelFailureKind,
    failure: Omit<LimrunTunnelFailure, 'at'>,
    count = 1,
  ): void => {
    total += count;
    const entry = (byKind[kind] ??= { count: 0, latest: [] });
    entry.count += count;
    entry.latest.push({ ...failure, at: new Date().toISOString() });
    if (entry.latest.length > LATEST_FAILURES_PER_KIND) entry.latest.shift();
  };
  return {
    record,
    observe(event: DestinationTunnelInspectionEvent): void {
      if (event.type === 'complete' && event.data._limrun.error) {
        record('request-failed', {
          ...readUrlEndpoint(event.data.request.url),
          message: event.data._limrun.error,
        });
      } else if (event.type === 'inspection_error') {
        const { host, port, message } = event.data;
        record('inspection-error', {
          ...(typeof host === 'string' ? { host } : {}),
          ...(typeof port === 'number' ? { port } : {}),
          message,
        });
      } else if (event.type === 'gap') {
        record('inspection-gap', { message: event.data.message });
      }
    },
    report(
      lastDialFailure: LimrunTunnelFailureReport['lastDialFailure'],
    ): LimrunTunnelFailureReport {
      return {
        total,
        byKind: Object.fromEntries(
          Object.entries(byKind).map(([kind, entry]) => [
            kind,
            { count: entry.count, latest: [...entry.latest] },
          ]),
        ),
        ...(lastDialFailure ? { lastDialFailure } : {}),
      };
    },
  };
}

/** Best effort: the status read is bounded well below a listing or close request. */
async function readLastDialFailure(
  client: LimrunHarTunnelClient,
  tunnelId: string,
  selectors: DestinationTcpTunnel['selectors'],
): Promise<LimrunTunnelFailureReport['lastDialFailure']> {
  const readStatus = client.getTunnelStatus;
  if (!readStatus) return undefined;
  const status = await new Promise<Awaited<ReturnType<typeof readStatus>> | undefined>(
    (resolve) => {
      const timer = setTimeout(() => resolve(undefined), TUNNEL_STATUS_BUDGET_MS);
      readStatus
        .call(client)
        .then(resolve, () => resolve(undefined))
        .finally(() => clearTimeout(timer));
    },
  );
  const failure = status?.lastDialFailure;
  if (!failure || failure.tunnelId !== tunnelId) return undefined;
  const selector = selectors?.find((report) => report.id === failure.selectorId)?.value;
  return {
    reason: failure.reason,
    ...(failure.osCode ? { osCode: failure.osCode } : {}),
    ...(selector ? { selector } : {}),
  };
}

function readUrlEndpoint(url: string): Readonly<{ host?: string; port?: number }> {
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'http:'
          ? 80
          : undefined;
    return { host: parsed.hostname, ...(port === undefined ? {} : { port }) };
  } catch {
    return {};
  }
}

const HAR_HEADER =
  '{"log":{"version":"1.2","creator":{"name":"agent-device limrun-tunnel","version":"1"},"entries":[';

/**
 * The HAR file of one capture. Each entry is serialized once into a ring capped at
 * `HAR_MAX_BYTES`; a write joins the ring, so its cost is bounded too. Writes coalesce, and one
 * runs at a time, off the event loop.
 */
function createHarFile(
  harPath: string,
  hooks: Readonly<{ onDropped: (count: number) => void; onWriteError: (error: unknown) => void }>,
) {
  const entries: string[] = [];
  let bytes = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let tempSequence = 0;
  const write = async (): Promise<void> => {
    // A fresh, exclusively created temp file, renamed into place: a reader never sees a partial
    // document, and the published file always carries the owner-only mode.
    tempSequence += 1;
    const tempPath = `${harPath}.${process.pid}-${tempSequence}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, `${HAR_HEADER}${entries.join(',')}]}}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      await fs.promises.rename(tempPath, harPath);
    } catch (error) {
      hooks.onWriteError(error);
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  };
  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    while (inFlight) await inFlight;
    inFlight = write().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };
  return {
    flush,
    add(entry: unknown): void {
      const serialized = JSON.stringify(entry);
      entries.push(serialized);
      bytes += serialized.length;
      let dropped = 0;
      while (bytes > HAR_MAX_BYTES && entries.length > 1) {
        bytes -= entries.shift()?.length ?? 0;
        dropped += 1;
      }
      if (dropped > 0) hooks.onDropped(dropped);
      timer ??= setTimeout(() => void flush(), HAR_WRITE_COALESCE_MS);
    },
  };
}

/** Deletes a capture's HAR file once nothing reports it any more. */
export async function discardLimrunHar(harPath: string): Promise<void> {
  await fs.promises.rm(harPath, { force: true });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
