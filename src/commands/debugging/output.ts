import type { DebugSymbolsResult } from '../../client/client-types.ts';
import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';

function debugSymbolsCliOutput(result: DebugSymbolsResult): CliOutput {
  const lines = [result.outPath, result.message];
  lines.push(...formatDebugCrashSummary(result));
  for (const image of result.matchedImages) {
    lines.push(`Matched: ${image.name} ${image.uuid}${image.arch ? ` ${image.arch}` : ''}`);
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  return { data: result, text: lines.join('\n') };
}

export const debuggingCliOutputFormatters = {
  debug: resultOutput(debugSymbolsCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function formatDebugCrashSummary(result: DebugSymbolsResult): string[] {
  const crash = result.crash;
  const lines = [
    `Crash: ${crash.appName ?? 'unknown app'}${crash.crashedThread === undefined ? '' : ` thread ${crash.crashedThread}`}`,
  ];
  if (crash.bundleId) lines.push(`Bundle: ${crash.bundleId}`);
  if (crash.exceptionType) lines.push(`Exception: ${crash.exceptionType}`);
  if (crash.terminationReason) lines.push(`Termination: ${crash.terminationReason}`);
  for (const frame of crash.topFrames) {
    lines.push(`Frame ${frame.index}: ${frame.image} ${frame.symbol ?? frame.address}`);
  }
  for (const finding of crash.findings) {
    lines.push(`Finding: ${finding}`);
  }
  return lines;
}
