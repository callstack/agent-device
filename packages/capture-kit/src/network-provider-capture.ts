import type {
  NetworkAppLogRead,
  NetworkDumpInput,
  NetworkProviderDumpResult,
  NetworkTransportScope,
} from '@agent-device/contracts/network-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { LogBackend } from '@agent-device/contracts/observability';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import { readRecentNetworkTrafficFromText, type NetworkScan } from './network-traffic.ts';

/**
 * A provider source answers a dump with entries, with nothing yet to report, or not at all.
 * `unavailable` carries why: a session whose app-side capture broke mid-repro must not read as
 * an empty traffic window.
 */
export type NetworkProviderCapture =
  | Readonly<{ status: 'captured'; result: NetworkProviderDumpResult }>
  | Readonly<{ status: 'armed'; notes: readonly string[] }>
  | Readonly<{
      status: 'unavailable';
      /** The session names a provider source that could not answer; the note says why. */
      notes: readonly string[];
    }>;

// A wedged app runtime must not cost the dump more than this; the session's second capture
// source answers after it, well inside the command envelope.
const PROVIDER_CAPTURE_BUDGET_MS = 12_000;

/**
 * Reads one session's provider network source, when its transport declares one. A provider that
 * only armed its capture during this call reports `armed` with no entries, so the caller answers
 * the current window from its own source and keeps the arming note. Every provider failure stays
 * a typed `unavailable` note; this function never throws. The caller passes a resolver for the
 * dev-server identity of exactly one device attached to this host
 * (`resolveMetroDeviceIdentity`); a transport calls it only inside a dump, so a non-React-Native
 * session never pays for the probe, and without an identity the provider fails closed.
 */
export async function captureNetworkProviderTraffic(
  host: Pick<PlatformRuntimeHost, 'networkTransports'>,
  device: DeviceInfo,
  input: NetworkDumpInput,
  signal: AbortSignal,
  options: {
    resolveMetroDeviceIdentity?: (signal: AbortSignal) => Promise<string | undefined>;
  } = {},
): Promise<NetworkProviderCapture> {
  // A provider dump injects into the runtime it selects, so it runs only for a session that names
  // its app. The identity gate lives in the dump itself, which fails closed without one.
  if (input.appBundleId === undefined) return { status: 'unavailable', notes: [] };
  const scope: NetworkTransportScope = {
    sessionId: input.sessionId,
    stateDir: input.stateDir,
    appBundleId: input.appBundleId,
    maxPayloadChars: input.maxPayloadChars,
    ...(options.resolveMetroDeviceIdentity === undefined
      ? {}
      : { resolveMetroDeviceIdentity: options.resolveMetroDeviceIdentity }),
  };
  let transport;
  try {
    transport = await host.networkTransports.resolve(device, scope);
  } catch (error) {
    return { status: 'unavailable', notes: [providerFailureNote(error)] };
  }
  const dump = transport.dump;
  if (!dump) return { status: 'unavailable', notes: [] };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_CAPTURE_BUDGET_MS)]);
  let result;
  try {
    // Racing the budget signal bounds the whole provider read: the transport's own steps can
    // each carry longer internal timeouts, and an unbounded provider would push the dump past
    // the command envelope while its work keeps running after capture-kit moved on.
    result = await Promise.race([
      dump({ maxEntries: input.maxEntries, include: input.include }, bounded),
      abortRejection(bounded, input.sessionId),
    ]);
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'unavailable', notes: [providerFailureNote(error)] };
  }
  if (result.armed && result.entries.length === 0) {
    return { status: 'armed', notes: result.notes ?? [] };
  }
  return { status: 'captured', result };
}

function abortRejection(signal: AbortSignal, sessionId: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`The in-app network capture exceeded its budget for session ${sessionId}.`));
      return;
    }
    signal.addEventListener(
      'abort',
      () =>
        reject(
          new Error(`The in-app network capture exceeded its budget for session ${sessionId}.`),
        ),
      { once: true },
    );
  });
}

function providerFailureNote(error: unknown): string {
  // The message can carry text from a local dev server or the app runtime, so it passes through
  // the diagnostic redaction owner before it reaches a response note.
  const { message } = redactDiagnosticData({
    message: error instanceof Error ? error.message : String(error),
  });
  return `In-app network capture could not answer this dump: ${message} This dump reads the session app log instead.`;
}

/** A platform's app-log fallback window: the scan and the file identity its notes name. */
export type NetworkAppLogFallback = Readonly<{
  scan: NetworkScan;
  recent: NetworkAppLogRead;
}>;

/**
 * Reads the session app log and scans it for HTTP traffic: the fallback every platform answers
 * from when its provider source has nothing to report. `backend` names the log family the parser
 * applies.
 */
export async function scanNetworkAppLogFallback(
  host: Pick<PlatformRuntimeHost, 'appLogs'>,
  input: NetworkDumpInput,
  backend: LogBackend,
): Promise<NetworkAppLogFallback> {
  const recent = await host.appLogs.readRecent(input.sessionId, input.maxScanLines);
  const scan = readRecentNetworkTrafficFromText(recent.text, {
    ...input,
    path: recent.path,
    exists: recent.exists,
    lineNumberOffset: recent.skippedLines,
    backend,
  });
  return { scan, recent };
}
