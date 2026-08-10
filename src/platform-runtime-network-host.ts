import fs from 'node:fs';
import type {
  AppLogProcessMarkerReadOutcome,
  AppLogSessionArtifacts,
  NetworkAppLogRead,
  NetworkRuntimeHost,
  NetworkTransport,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { openVerifiedFileForRead } from './utils/verified-file.ts';

type ProcessMarkerReader = Readonly<{
  readMarker(pathname: string): Promise<AppLogProcessMarkerReadOutcome>;
}>;

export function createNetworkRuntimeHost(
  options: Readonly<{
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    processes: ProcessMarkerReader;
    resolveTransport(device: DeviceInfo): Promise<NetworkTransport>;
  }>,
): Pick<NetworkRuntimeHost, 'appLogs' | 'networkTransports'> {
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
