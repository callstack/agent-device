import { DestinationTunnelHARAssembler } from '@limrun/api/destination-tunnel-har';
import { DestinationTunnelSessionError } from '@limrun/api/destination-tunnel-dialer';
import type { DestinationTunnelHAREntry } from '@limrun/api/destination-tunnel-har';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import type { DestinationTcpTunnel } from '@limrun/api/destination-tunnel-dialer';
import { validateDestinationTunnelSelectors } from '@limrun/api/destination-tunnel';
import type { NetworkEntry } from '@agent-device/contracts/observability';
import type { NetworkCaptureStopResult } from '@agent-device/contracts/network-runtime';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';

/**
 * The Limrun live capture source (ADR 0037, source 3a): Limrun's own tunnel inspection.
 *
 * `start` opens the instance's one destination tunnel with inspection enabled. The tunnel
 * DNS-routes the listed domains through this host, decrypts HTTPS with a certificate the device
 * already trusts, and streams every completed request live as a HAR 1.2 entry with headers,
 * bodies, and timings. `readEntries` answers from a bounded newest-first buffer, so a dump never
 * installs instrumentation and never switches source. `stop` closes the tunnel and drops it.
 *
 * Known limits: the app must launch after the tunnel starts (reported as `requiresRelaunch`),
 * apps that pin certificates fail on captured hosts (reported as typed notes), and apps that use
 * DNS-over-HTTPS bypass the capture entirely.
 */

/** One instance carries one active tunnel, so one device session owns the capture alone. */
const LIMRUN_NETWORK_CAPTURE_SOURCE = 'limrun-tunnel';

/**
 * Default selectors: the generic public TLD wildcards the research measured (Limrun accepts them),
 * so a normal app's API traffic is captured without configuration. Exact hosts and subdomains are
 * valid selectors too and come from the operator's host list.
 */
export const DEFAULT_LIMRUN_CAPTURE_HOSTS = Object.freeze([
  '*.com',
  '*.org',
  '*.app',
  '*.net',
  '*.io',
  '*.dev',
] as const);

const MAX_CAPTURED_HOSTS = 64;
const MAX_BUFFERED_ENTRIES = 200;
/** Per-request body budget the inspection keeps; larger bodies arrive flagged as truncated. */
const MAX_INSPECTED_BODY_BYTES = 2 * 1024 * 1024;

export type LimrunTunnelClient = Readonly<{
  startTunnel(options: {
    selectors: string[];
    inspection?: { enabled?: boolean; captureBodies?: boolean; maxBodyBytes?: number };
    onInspectionEvent?: (event: DestinationTunnelInspectionEvent) => void;
    onInspectionError?: (error: Error) => void;
  }): Promise<DestinationTcpTunnel>;
}>;

export type LimrunCaptureHosts =
  | Readonly<{ ok: true; hosts: readonly string[] }>
  | Readonly<{
      ok: false;
      reason: 'unsupported-device';
      message: string;
    }>;

/** A start refusal; the shared command maps these to its own response shape. */
export type LimrunCaptureStartRefusal = Readonly<{
  reason: 'tunnel-in-use' | 'capture-stopped' | 'unsupported-device';
  message: string;
}>;

export type LimrunNetworkCapture = Readonly<{
  source: typeof LIMRUN_NETWORK_CAPTURE_SOURCE;
  /** Start inspection. Refuses while a capture already runs on this device. */
  start(
    hosts: readonly string[] | undefined,
  ): Promise<
    | Readonly<{ ok: true; hosts: readonly string[]; capturingBodies: true }>
    | Readonly<{ ok: false } & LimrunCaptureStartRefusal>
  >;
  stop(): Promise<NetworkCaptureStopResult>;
  /**
   * Newest-first entries, redacted, trimmed to the dump's include mode.
   */
  readEntries(input: Readonly<{ maxEntries: number; include: string }>): readonly NetworkEntry[];
  /** Whether inspection is live on this device right now. */
  readonly running: boolean;
  /** Typed notes for hosts the entries reveal as pinned or failed. */
  notes(): readonly string[];
}>;

export function createLimrunNetworkCapture(client: LimrunTunnelClient): LimrunNetworkCapture {
  const entries: NetworkEntry[] = [];
  const failedHosts = new Map<string, string>();
  let tunnel: DestinationTcpTunnel | undefined;
  let starting: Promise<DestinationTcpTunnel> | undefined;
  // One capture window has one generation. stop() advances it, so an inspection event already in
  // flight when the tunnel closed is dropped instead of entering the next window's buffer.
  let generation = 0;

  const createEventHandler = (window: number) => {
    const assembler = new DestinationTunnelHARAssembler(MAX_INSPECTED_BODY_BYTES);
    return (event: DestinationTunnelInspectionEvent) => {
      if (window !== generation) return;
      if (event.type === 'gap') {
        failedHosts.set('inspection', 'inspection stream gap');
        return;
      }
      if (event.type === 'inspection_error') {
        failedHosts.set(readErrorHost(event.data.message) ?? 'inspection', 'inspection error');
        return;
      }
      const completed = assembler.add(event);
      if (!completed) return;
      const host = readEntryHost(completed);
      const error = completed._limrun?.error;
      if (error) {
        if (host) failedHosts.set(host, error);
        return;
      }
      entries.unshift(mapHarEntry(completed, entries.length + 1));
      if (entries.length > MAX_BUFFERED_ENTRIES) entries.length = MAX_BUFFERED_ENTRIES;
    };
  };

  return {
    source: LIMRUN_NETWORK_CAPTURE_SOURCE,
    get running() {
      return tunnel !== undefined;
    },
    start: async (requestedHosts) => {
      if (tunnel || starting) {
        return {
          ok: false,
          reason: 'tunnel-in-use',
          message: 'A Limrun network capture is already running for this device.',
        };
      }
      const hosts = resolveHosts(requestedHosts);
      if (!hosts.ok) return hosts;
      const window = ++generation;
      entries.length = 0;
      failedHosts.clear();
      const opening = client.startTunnel({
        selectors: [...hosts.hosts],
        inspection: {
          enabled: true,
          captureBodies: true,
          maxBodyBytes: MAX_INSPECTED_BODY_BYTES,
        },
        onInspectionEvent: createEventHandler(window),
        // The error callback is window-tagged like the event handler: a late error from a closed
        // window must not contaminate the next window's notes.
        onInspectionError: (error) => {
          if (window !== generation) return;
          failedHosts.set('inspection', error.message.slice(0, 200));
        },
      });
      starting = opening;
      let opened: DestinationTcpTunnel;
      try {
        opened = await opening;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          reason: classifyStartFailure(error),
          message: `Limrun tunnel inspection could not start: ${message.slice(0, 300)}`,
        };
      } finally {
        starting = undefined;
      }
      if (window !== generation) {
        // The window closed while this tunnel was opening (a stop ran, or a restart advanced the
        // generation): its traffic belongs to no live window, so close it rather than adopt it.
        opened.close();
        return {
          ok: false,
          reason: 'capture-stopped',
          message: 'The capture stopped while the tunnel was opening.',
        };
      }
      tunnel = opened;
      return { ok: true, hosts: hosts.hosts, capturingBodies: true };
    },
    stop: async () => {
      // Make an open that is in flight stale before waiting for it: its window loses, start closes
      // the late tunnel itself, and the capture ends stopped rather than re-armed.
      ++generation;
      await starting?.catch(() => undefined);
      if (!tunnel) return { stopped: false };
      tunnel.close();
      tunnel = undefined;
      entries.length = 0;
      failedHosts.clear();
      return { stopped: true };
    },
    readEntries: ({ maxEntries, include }) => {
      // `line` names the display position in this read, not a source line: a provider capture has
      // no log file, so each dump numbers its own newest-first window from 1.
      const limit = Math.max(0, Math.min(maxEntries, MAX_BUFFERED_ENTRIES));
      return entries
        .slice(0, limit)
        .map((entry, index) => ({ ...trimToInclude(entry, include), line: index + 1 }));
    },
    notes: () => {
      if (failedHosts.size === 0) return [];
      const hosts = [...failedHosts.keys()];
      // The inspection extension reports failures only as free text, so the pinned-class check and
      // readErrorHost below read the message; no typed code exists to match.
      const pinned = hosts.filter((host) =>
        /tls|certificate|handshake|ssl/i.test(failedHosts.get(host) ?? ''),
      );
      const visible = hosts.slice(0, 10);
      const notes = [
        `Captured hosts with failed or rejected connections (a pinned host fails closed through the tunnel): ${visible.join(', ')}`,
      ];
      if (pinned.length > 0) {
        notes.push(
          `Likely certificate-pinned hosts: ${pinned.slice(0, 10).join(', ')}. Stop the capture and relaunch for those hosts.`,
        );
      }
      return notes;
    },
  };
}

function resolveHosts(requested: readonly string[] | undefined): LimrunCaptureHosts {
  const hosts =
    requested && requested.length > 0
      ? requested.map((host) => host.trim()).filter((host) => host.length > 0)
      : [...DEFAULT_LIMRUN_CAPTURE_HOSTS];
  if (hosts.length === 0) {
    return { ok: false, reason: 'unsupported-device', message: 'Capture hosts were all blank.' };
  }
  if (hosts.length > MAX_CAPTURED_HOSTS) {
    return {
      ok: false,
      reason: 'unsupported-device',
      message: `Limrun tunnel inspection accepts at most ${MAX_CAPTURED_HOSTS} hosts; ${hosts.length} were requested.`,
    };
  }
  try {
    validateDestinationTunnelSelectors(hosts);
  } catch (error) {
    return {
      ok: false,
      reason: 'unsupported-device',
      message: `Invalid capture host selector: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
    };
  }
  return { ok: true, hosts: Object.freeze([...hosts]) };
}

/** A second live tunnel on the instance is Limrun's typed `already_active` session error. */
function classifyStartFailure(error: unknown): 'tunnel-in-use' | 'unsupported-device' {
  return error instanceof DestinationTunnelSessionError && error.code === 'already_active'
    ? 'tunnel-in-use'
    : 'unsupported-device';
}

function readEntryHost(entry: DestinationTunnelHAREntry): string | undefined {
  try {
    return new URL(entry.request.url).hostname;
  } catch {
    return undefined;
  }
}

function readErrorHost(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const match = /(?:host|domain|server)[:=\s]+([a-z0-9.-]+\.[a-z]{2,})/i.exec(message);
  return match?.[1];
}

function mapHarEntry(entry: DestinationTunnelHAREntry, line: number): NetworkEntry {
  const durationMs = durationFromEntry(entry);
  const headers = harHeaders(entry);
  const redacted = redactDiagnosticData({
    url: entry.request.url,
    headers,
    requestBody: harBody(entry.request.postData?.text),
    responseBody: harBody(entry.response.content?.text),
  });
  return {
    method: entry.request.method,
    url: redacted.url,
    ...(Number.isFinite(entry.response.status) ? { status: entry.response.status } : {}),
    ...(entry.startedDateTime ? { timestamp: entry.startedDateTime } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(redacted.headers === undefined ? {} : { headers: redacted.headers }),
    ...(redacted.requestBody === undefined ? {} : { requestBody: redacted.requestBody }),
    ...(redacted.responseBody === undefined ? {} : { responseBody: redacted.responseBody }),
    raw: `${entry.request.method} ${redacted.url} ${entry.response.status}`,
    line,
  };
}

function harHeaders(entry: DestinationTunnelHAREntry): string | undefined {
  const requestHeaders = Object.fromEntries(
    (entry.request.headers ?? []).map((header) => [header.name, header.value]),
  );
  const responseHeaders = Object.fromEntries(
    (entry.response.headers ?? []).map((header) => [header.name, header.value]),
  );
  if (Object.keys(requestHeaders).length + Object.keys(responseHeaders).length === 0) {
    return undefined;
  }
  return JSON.stringify({ request: requestHeaders, response: responseHeaders });
}

function harBody(text: string | undefined): string | undefined {
  return text === undefined || text.length === 0 ? undefined : text;
}

function durationFromEntry(entry: DestinationTunnelHAREntry): number | undefined {
  if (Number.isFinite(entry.time) && entry.time >= 0) return Math.round(entry.time);
  const timings = entry.timings;
  const parts = [
    timings?.blocked,
    timings?.dns,
    timings?.connect,
    timings?.send,
    timings?.wait,
    timings?.receive,
  ].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
  return parts.length === 0 ? undefined : Math.round(parts.reduce((a, b) => a + b, 0));
}

/** Bodies and headers stay opt-in for output; the buffer keeps everything the tunnel inspected. */
function trimToInclude(entry: NetworkEntry, include: string): NetworkEntry {
  const { headers, requestBody, responseBody, ...summary } = entry;
  switch (include) {
    case 'headers':
      return { ...summary, ...(headers === undefined ? {} : { headers }) };
    case 'body':
      return {
        ...summary,
        ...(requestBody === undefined ? {} : { requestBody }),
        ...(responseBody === undefined ? {} : { responseBody }),
      };
    case 'all':
      return {
        ...summary,
        ...(headers === undefined ? {} : { headers }),
        ...(requestBody === undefined ? {} : { requestBody }),
        ...(responseBody === undefined ? {} : { responseBody }),
      };
    default:
      return summary;
  }
}
