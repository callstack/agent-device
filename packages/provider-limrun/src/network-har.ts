import { DestinationTunnelHARAssembler } from '@limrun/api/destination-tunnel-har';
import { validateDestinationTunnelSelectors } from '@limrun/api/destination-tunnel';
import { DestinationTunnelSessionError } from '@limrun/api/destination-tunnel-dialer';
import type { DestinationTunnelHAREntry } from '@limrun/api/destination-tunnel-har';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import type { DestinationTcpTunnel } from '@limrun/api/destination-tunnel-dialer';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Limrun network capture: one destination tunnel with inspection. Completed requests stay in
 * memory, with each body cut to `HAR_BODY_LIMIT_BYTES` and at most `HAR_MAX_ENTRIES` entries, and
 * `writeLimrunHar` writes them as a HAR 1.2 file when `artifacts` or close asks for it.
 *
 * One instance carries one destination tunnel, so the Metro route rides this tunnel: the default
 * selectors include `localhost:8081`.
 *
 * The SDK logs tunnel failures only to the console, so the capture counts the typed ones itself
 * and reads the tunnel's last typed dial failure on demand.
 */

/** Generic public-TLD wildcards, measured acceptable by Limrun's selector validation. */
const DEFAULT_LIMRUN_HAR_SELECTORS = Object.freeze([
  '*.com',
  '*.org',
  '*.app',
  '*.net',
  '*.io',
  '*.dev',
  'localhost:8081',
] as const);

const HAR_BODY_LIMIT_BYTES = 64 * 1024;
const HAR_MAX_ENTRIES = 500;
const TUNNEL_STATUS_BUDGET_MS = 2_000;

export type LimrunHarTunnelClient = Readonly<{
  startTunnel(options: {
    selectors: string[];
    inspection?: { enabled?: boolean; captureBodies?: boolean; maxBodyBytes?: number };
    onInspectionEvent?: (event: DestinationTunnelInspectionEvent) => void;
    onInspectionError?: (error: Error) => void;
  }): Promise<DestinationTcpTunnel>;
  getTunnelStatus?(): Promise<
    Readonly<{ lastDialFailure?: Readonly<{ tunnelId: string; reason: string }> }>
  >;
}>;

/**
 * - `request-failed`: the tunnel could not complete a request; its HAR entry has status 0.
 * - `inspection-error`: the tunnel could not inspect a connection, usually a pinned certificate.
 * - `inspection-gap`, `inspection-stream-error`: the HAR misses requests.
 * - `har-truncated`: the oldest entry left the HAR to keep it under `HAR_MAX_ENTRIES`.
 */
export type LimrunNetworkFailureKind =
  | 'request-failed'
  | 'inspection-error'
  | 'inspection-gap'
  | 'inspection-stream-error'
  | 'har-truncated';

export type LimrunNetworkFailures = Readonly<{
  count: number;
  last?: Readonly<{ kind: LimrunNetworkFailureKind; host?: string; port?: number }>;
  /** The tunnel's most recent dial failure reason, such as `dns_not_found`. */
  lastDialFailure?: string;
}>;

export type LimrunHarCapture = Readonly<{
  entries(): readonly DestinationTunnelHAREntry[];
  failures(): Promise<LimrunNetworkFailures>;
  close(): void;
}>;

export type LimrunHarCaptureResult =
  | Readonly<{ ok: true; capture: LimrunHarCapture }>
  | Readonly<{ ok: false; reason: 'tunnel-in-use' | 'tunnel-start-failed'; message: string }>;

/** Opens the instance's destination tunnel with inspection. Bodies are captured. */
export async function startLimrunHarCapture(
  client: LimrunHarTunnelClient,
  hosts: readonly string[] | undefined,
): Promise<LimrunHarCaptureResult> {
  const entries: DestinationTunnelHAREntry[] = [];
  let failures: { count: number; last?: LimrunNetworkFailures['last'] } = { count: 0 };
  const fail = (kind: LimrunNetworkFailureKind, host?: unknown, port?: unknown): void => {
    failures = {
      count: failures.count + 1,
      last: {
        kind,
        ...(typeof host === 'string' ? { host } : {}),
        ...(typeof port === 'number' ? { port } : {}),
      },
    };
  };
  const assembler = new DestinationTunnelHARAssembler(HAR_BODY_LIMIT_BYTES);
  let closed = false;
  try {
    const selectors = [...(hosts ?? DEFAULT_LIMRUN_HAR_SELECTORS)];
    validateDestinationTunnelSelectors(selectors);
    const tunnel = await client.startTunnel({
      selectors,
      inspection: { enabled: true, captureBodies: true, maxBodyBytes: HAR_BODY_LIMIT_BYTES },
      onInspectionEvent: (event) => {
        if (closed) return;
        const entry = assembler.add(event);
        if (entry) entries.push(entry);
        if (entries.length > HAR_MAX_ENTRIES) {
          entries.shift();
          fail('har-truncated');
        }
        if (event.type === 'complete' && event.data._limrun.error) {
          const url = URL.parse(event.data.request.url);
          fail('request-failed', url?.hostname, defaultPort(url));
        } else if (event.type === 'inspection_error') {
          fail('inspection-error', event.data.host, event.data.port);
        } else if (event.type === 'gap') {
          fail('inspection-gap');
        }
      },
      onInspectionError: () => fail('inspection-stream-error'),
    });
    return {
      ok: true,
      capture: {
        entries: () => [...entries],
        failures: async () => {
          const lastDialFailure = closed ? undefined : await readLastDialFailure(client, tunnel);
          return { ...failures, ...(lastDialFailure ? { lastDialFailure } : {}) };
        },
        close: () => {
          closed = true;
          tunnel.close();
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof DestinationTunnelSessionError && error.code === 'already_active'
          ? 'tunnel-in-use'
          : 'tunnel-start-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Writes the entries as a HAR 1.2 file that only the daemon's user can read. */
export async function writeLimrunHar(
  harPath: string,
  entries: readonly DestinationTunnelHAREntry[],
): Promise<void> {
  await fs.promises.mkdir(path.dirname(harPath), { recursive: true, mode: 0o700 });
  const har = {
    log: { version: '1.2', creator: { name: 'agent-device', version: '1' }, entries },
  };
  await fs.promises.writeFile(harPath, `${JSON.stringify(har)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created.
  await fs.promises.chmod(harPath, 0o600);
}

/** The status read takes no signal, so a slow read is abandoned after the budget. */
async function readLastDialFailure(
  client: LimrunHarTunnelClient,
  tunnel: DestinationTcpTunnel,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const status = await Promise.race([
    client.getTunnelStatus?.().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), TUNNEL_STATUS_BUDGET_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const failure = status?.lastDialFailure;
  return failure?.tunnelId === tunnel.tunnelId ? failure.reason : undefined;
}

function defaultPort(url: URL | null): number | undefined {
  if (!url) return undefined;
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : undefined;
}
