import type {
  CrashArtifact,
  DebugSymbolsCrashFrame,
  DebugSymbolsCrashSummary,
  IpsDocument,
  IpsFrameMatch,
  SymbolicatedAddress,
  TextFrameMatch,
} from './types.ts';
import { isRecord } from '../../../utils/parsing.ts';
import {
  addressKey,
  compactJoin,
  firstString,
  hex,
  readNumber,
  readJsonRecord,
  readString,
} from './utils.ts';

const MAX_CRASH_SUMMARY_FRAMES = 5;
const MAX_CRASH_FINDINGS = 3;

export function summarizeCrashArtifact(
  artifact: CrashArtifact,
  addressMap: Map<string, SymbolicatedAddress>,
): DebugSymbolsCrashSummary {
  return artifact.format === 'ips'
    ? summarizeIpsCrash(artifact.document, artifact.frameMatches, addressMap)
    : summarizeTextCrash(artifact.lines, artifact.frameMatches, addressMap);
}

function summarizeIpsCrash(
  document: IpsDocument,
  frameMatches: IpsFrameMatch[],
  addressMap: Map<string, SymbolicatedAddress>,
): DebugSymbolsCrashSummary {
  const crashedThread = readIpsCrashedThread(document.payload);
  const summary: DebugSymbolsCrashSummary = {
    format: 'ips',
    ...readIpsCrashMetadata(document),
    crashedThread,
    topFrames: summarizeIpsFrames(frameMatches, crashedThread, addressMap),
    findings: [],
  };
  return { ...summary, findings: crashFindings(summary) };
}

function readIpsCrashMetadata(
  document: IpsDocument,
): Omit<DebugSymbolsCrashSummary, 'format' | 'crashedThread' | 'topFrames' | 'findings'> {
  const payload = document.payload;
  const header = readIpsHeader(document.header);
  return {
    appName: readIpsAppName(payload, header),
    bundleId: readIpsBundleId(payload, header),
    version: readIpsVersion(payload, header),
    incident: readIpsIncident(payload, header),
    timestamp: readIpsTimestamp(payload, header),
    exceptionType: readIpsExceptionType(payload.exception),
    exceptionCodes: readIpsExceptionCodes(payload.exception),
    terminationReason: readIpsTerminationReason(payload.termination),
  };
}

function readIpsAppName(
  payload: Record<string, unknown>,
  header: Record<string, unknown> | null,
): string | undefined {
  return firstString(payload.procName, header?.app_name, header?.name);
}

function readIpsBundleId(
  payload: Record<string, unknown>,
  header: Record<string, unknown> | null,
): string | undefined {
  const bundleInfo = isRecord(payload.bundleInfo) ? payload.bundleInfo : undefined;
  return firstString(bundleInfo?.CFBundleIdentifier, header?.bundleID);
}

function readIpsVersion(
  payload: Record<string, unknown>,
  header: Record<string, unknown> | null,
): string | undefined {
  const bundleInfo = isRecord(payload.bundleInfo) ? payload.bundleInfo : undefined;
  return firstString(bundleInfo?.CFBundleShortVersionString, header?.app_version);
}

function readIpsIncident(
  payload: Record<string, unknown>,
  header: Record<string, unknown> | null,
): string | undefined {
  return firstString(payload.incident, header?.incident_id);
}

function readIpsTimestamp(
  payload: Record<string, unknown>,
  header: Record<string, unknown> | null,
): string | undefined {
  return firstString(payload.captureTime, header?.timestamp);
}

function readIpsExceptionType(exception: unknown): string | undefined {
  return isRecord(exception) ? readString(exception.type) : undefined;
}

function readIpsHeader(header: string | undefined): Record<string, unknown> | null {
  return header ? readJsonRecord(header) : null;
}

function readIpsCrashedThread(payload: Record<string, unknown>): number | undefined {
  const faultingThread = readNumber(payload.faultingThread);
  if (faultingThread !== undefined) return faultingThread;
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  const triggeredIndex = threads.findIndex(
    (thread) => isRecord(thread) && thread.triggered === true,
  );
  return triggeredIndex === -1 ? undefined : triggeredIndex;
}

function readIpsExceptionCodes(exception: unknown): string | undefined {
  return isRecord(exception) ? firstString(exception.codes, exception.rawCodes) : undefined;
}

function readIpsTerminationReason(termination: unknown): string | undefined {
  if (!isRecord(termination)) return undefined;
  return compactJoin([
    readString(termination.namespace),
    readString(termination.code),
    readString(termination.reason),
  ]);
}

function summarizeIpsFrames(
  frameMatches: IpsFrameMatch[],
  crashedThread: number | undefined,
  addressMap: Map<string, SymbolicatedAddress>,
): DebugSymbolsCrashFrame[] {
  return frameMatches
    .filter((match) => crashedThread === undefined || match.threadIndex === crashedThread)
    .slice(0, MAX_CRASH_SUMMARY_FRAMES)
    .map((match) => crashFrameSummary(match.frameIndex, match.image, match.address, addressMap));
}

function summarizeTextCrash(
  lines: string[],
  frameMatches: TextFrameMatch[],
  addressMap: Map<string, SymbolicatedAddress>,
): DebugSymbolsCrashSummary {
  const crashedThread = readTextCrashedThread(lines);
  const summary: DebugSymbolsCrashSummary = {
    format: 'text',
    appName: readTextProcessName(lines),
    bundleId: readTextField(lines, 'Identifier'),
    version: readTextField(lines, 'Version'),
    incident: readTextField(lines, 'Incident Identifier'),
    timestamp: readTextField(lines, 'Date/Time'),
    exceptionType: readTextField(lines, 'Exception Type'),
    exceptionCodes: readTextField(lines, 'Exception Codes'),
    terminationReason: readTextField(lines, 'Termination Reason'),
    crashedThread,
    topFrames: summarizeTextFrames(frameMatches, crashedThread, addressMap),
    findings: [],
  };
  return { ...summary, findings: crashFindings(summary) };
}

function readTextProcessName(lines: string[]): string | undefined {
  const process = readTextField(lines, 'Process');
  return process?.replace(/\s+\[\d+\]$/, '');
}

function readTextField(lines: string[], label: string): string | undefined {
  const prefix = `${label}:`;
  const line = lines.find((candidate) => candidate.trimStart().startsWith(prefix));
  return line ? line.slice(line.indexOf(':') + 1).trim() || undefined : undefined;
}

function readTextCrashedThread(lines: string[]): number | undefined {
  const triggered = readTextField(lines, 'Triggered by Thread');
  const triggeredThread = triggered ? Number.parseInt(triggered, 10) : Number.NaN;
  if (Number.isSafeInteger(triggeredThread)) return triggeredThread;
  for (const line of lines) {
    const match = line.match(/^Thread\s+(\d+)\s+Crashed:/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function summarizeTextFrames(
  frameMatches: TextFrameMatch[],
  crashedThread: number | undefined,
  addressMap: Map<string, SymbolicatedAddress>,
): DebugSymbolsCrashFrame[] {
  if (crashedThread === undefined) return [];
  return frameMatches
    .filter((match) => match.threadIndex === crashedThread)
    .slice(0, MAX_CRASH_SUMMARY_FRAMES)
    .map((match) => crashFrameSummary(match.frameIndex, match.image, match.address, addressMap));
}

function crashFrameSummary(
  index: number,
  image: { name: string; uuid: string },
  address: bigint,
  addressMap: Map<string, SymbolicatedAddress>,
): DebugSymbolsCrashFrame {
  return {
    index,
    image: image.name,
    address: hex(address),
    symbol: addressMap.get(addressKey(image, address))?.text,
  };
}

function crashFindings(summary: DebugSymbolsCrashSummary): string[] {
  return [
    firstSymbolicatedFrameFinding(summary),
    summary.exceptionType ? `Exception: ${summary.exceptionType}` : undefined,
    summary.terminationReason ? `Termination: ${summary.terminationReason}` : undefined,
  ]
    .filter((finding): finding is string => Boolean(finding))
    .slice(0, MAX_CRASH_FINDINGS);
}

function firstSymbolicatedFrameFinding(summary: DebugSymbolsCrashSummary): string | undefined {
  const frame = summary.topFrames.find((candidate) => candidate.symbol);
  if (frame) {
    return `Start with ${frame.symbol} in ${frame.image}; it is the first symbolicated frame captured on the crashed thread.`;
  }
  return summary.topFrames.length > 0
    ? 'No symbolicated frame was found on the crashed thread; verify matching dSYMs for the top images.'
    : undefined;
}
