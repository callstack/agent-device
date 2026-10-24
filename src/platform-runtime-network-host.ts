import fs from 'node:fs';
import type {
  AppLogProcessMarkerReadOutcome,
  AppLogSessionArtifacts,
} from '@agent-device/contracts/app-log-runtime';
import type {
  NetworkAppLogRead,
  NetworkCaptureRead,
  NetworkRuntimeHost,
  NetworkTransport,
} from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { openVerifiedFileForRead } from '@agent-device/host-kit/file';
import { resolveSessionNetworkCapturePath } from '@agent-device/daemon-contracts/session-artifact-paths';
import { appLogRedactionPatterns, redact } from './platform-runtime-app-log-output.ts';

type ProcessMarkerReader = Readonly<{
  readMarker(pathname: string): Promise<AppLogProcessMarkerReadOutcome>;
}>;

/** Upper bound on one capture-probe read, so a long-running session cannot make a dump unbounded. */
const NETWORK_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The probe's own append cap (ADR 0037 rule 6, `AdMaxFileBytes` in ADNetworkCapture.m): once the
 * file reaches it the probe stops recording, and a dump must say so rather than report the frozen
 * window as current. Mirrored here as the reader's check; the probe source owns the value.
 */
export const NETWORK_CAPTURE_FILE_CAP_BYTES = 32 * 1024 * 1024;

export function createNetworkRuntimeHost(
  options: Readonly<{
    sessionsDir: string;
    env: NodeJS.ProcessEnv;
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    processes: ProcessMarkerReader;
    resolveTransport(device: DeviceInfo): Promise<NetworkTransport>;
  }>,
): Pick<NetworkRuntimeHost, 'appLogs' | 'captureProbe' | 'networkTransports'> {
  return Object.freeze({
    appLogs: Object.freeze({
      resolveSession: options.resolveSessionArtifacts,
      readRecent: async (sessionId: string, maxScanLines: number) => {
        const { outputPath } = options.resolveSessionArtifacts(sessionId);
        return readRecentAppLogLines(outputPath, maxScanLines);
      },
      readProcessMarker: async (sessionId: string) => {
        const { pidPath } = options.resolveSessionArtifacts(sessionId);
        return await options.processes.readMarker(pidPath);
      },
    }),
    captureProbe: Object.freeze({
      readRecent: async (sessionId: string, maxScanLines: number) =>
        readRecentNetworkCaptureLines({
          pathname: resolveSessionNetworkCapturePath(options.sessionsDir, sessionId),
          maxScanLines,
          redactionPatterns: appLogRedactionPatterns(options.env),
        }),
    }),
    networkTransports: Object.freeze({ resolve: options.resolveTransport }),
  });
}

export function readRecentAppLogLines(pathname: string, maxScanLines: number): NetworkAppLogRead {
  if (!Number.isInteger(maxScanLines) || maxScanLines < 1 || maxScanLines > 20_000) {
    throw new TypeError('Network app-log scan lines must be between 1 and 20000');
  }
  const descriptor = openVerifiedFileForRead(pathname);
  if (descriptor === undefined) {
    return Object.freeze({ path: pathname, exists: false, text: '', skippedLines: 0 });
  }
  try {
    const text = fs.readFileSync(descriptor, 'utf8');
    const recent = selectRecentLines(text, maxScanLines);
    return Object.freeze({
      path: pathname,
      exists: true,
      ...recent,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function selectRecentLines(
  text: string,
  maxScanLines: number,
): Readonly<{ text: string; skippedLines: number }> {
  const lines = text.split('\n');
  const skippedLines = Math.max(0, lines.length - maxScanLines);
  return Object.freeze({
    text: lines.slice(skippedLines).join('\n'),
    skippedLines,
  });
}

/**
 * Reads the tail of the capture probe's JSON-lines file for one session. The read is bounded in
 * bytes before it is bounded in lines: a probe file only grows while a session runs, and a dump must
 * stay a bounded read of the newest window. The operator's app-log redaction patterns are applied
 * here, so an entry whose header carries a secret reaches the response already masked.
 */
export function readRecentNetworkCaptureLines(
  input: Readonly<{
    pathname: string;
    maxScanLines: number;
    redactionPatterns: readonly RegExp[];
  }>,
): NetworkCaptureRead {
  if (!Number.isInteger(input.maxScanLines) || input.maxScanLines < 1) {
    throw new TypeError('Network capture scan lines must be a positive integer');
  }
  const descriptor = openVerifiedFileForRead(input.pathname);
  if (descriptor === undefined) {
    return Object.freeze({
      path: input.pathname,
      exists: false,
      text: '',
      skippedLines: 0,
      atSizeCap: false,
    });
  }
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, NETWORK_CAPTURE_MAX_BYTES);
    const start = size - length;
    // Same posture as the app-log tail: a byte window cut mid-line must not hand the parser a
    // partial entry, so one byte behind the window decides whether the first line is whole.
    const prefixLength = start > 0 ? 1 : 0;
    const buffer = Buffer.alloc(length + prefixLength);
    fs.readSync(descriptor, buffer, 0, buffer.length, start - prefixLength);
    let decoded = buffer.subarray(prefixLength).toString('utf8');
    let droppedPartialLine = 0;
    if (prefixLength > 0 && buffer[0] !== 0x0a) {
      const firstCompleteLine = decoded.indexOf('\n');
      decoded = firstCompleteLine < 0 ? '' : decoded.slice(firstCompleteLine + 1);
      droppedPartialLine = firstCompleteLine < 0 ? 0 : 1;
    }
    const recent = selectRecentLines(decoded, input.maxScanLines);
    return Object.freeze({
      path: input.pathname,
      exists: true,
      text: redact(recent.text, input.redactionPatterns),
      // Exact while the read covers the whole file; past the byte budget the window is the
      // newest frame, and the probe file's own line numbers are unreachable without a full read.
      skippedLines: recent.skippedLines + droppedPartialLine,
      // The probe stops appending at its own cap (ADR 0037 rule 6), so a file at that size means
      // the dump's window is the last thing the probe ever wrote, not the newest traffic.
      atSizeCap: size >= NETWORK_CAPTURE_FILE_CAP_BYTES,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}
