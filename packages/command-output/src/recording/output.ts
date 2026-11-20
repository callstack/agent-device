import type { CommandName } from '@agent-device/command-surface';
import type { CommandRequestResult } from '@agent-device/contracts/client';
import {
  collapseWarningText,
  resultOutput,
  type CliOutputFormatter,
  type CliOutput,
} from '../output-common.ts';

export function recordCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const outPath = typeof data.outPath === 'string' ? data.outPath : '';
  const chunks = readRecordingChunks(data);
  if (chunks.length <= 1) {
    return { data, text: formatRecordSingleOutput(data, outPath) };
  }

  const lines = ['Recording chunks:'];
  for (const chunk of chunks) {
    lines.push(`  ${chunk.index}: ${chunk.path}`);
  }
  if (typeof data.telemetryPath === 'string') {
    lines.push(`Telemetry: ${data.telemetryPath}`);
  }
  return { data, text: withRecordWarnings(lines, data) };
}

export const recordingCliOutputFormatters = {
  record: resultOutput(recordCliOutput),
} as const satisfies Partial<Record<CommandName, CliOutputFormatter>>;

function formatRecordSingleOutput(data: Record<string, unknown>, outPath: string): string {
  const lines: string[] = [];
  if (outPath) lines.push(outPath);
  if (typeof data.sessionStateDir === 'string')
    lines.push(`Session state: ${data.sessionStateDir}`);
  return withRecordWarnings(lines, data);
}

/**
 * The overlay warning and a remote daemon's own warning text, which are not response warnings; the
 * dispatcher prints the response warnings once.
 */
function withRecordWarnings(lines: string[], data: Record<string, unknown>): string {
  if (typeof data.overlayWarning === 'string') {
    lines.push(`Overlay warning: ${collapseWarningText(data.overlayWarning)}`);
  }
  for (const warning of Array.isArray(data.daemonWarnings) ? data.daemonWarnings : []) {
    if (typeof warning === 'string') lines.push(`Daemon warning: ${collapseWarningText(warning)}`);
  }
  return lines.join('\n');
}

function readRecordingChunks(
  data: Record<string, unknown>,
): Array<{ index: number; path: string }> {
  const rawChunks = data.chunks;
  if (!Array.isArray(rawChunks)) return [];
  return rawChunks.flatMap((chunk) => {
    if (!chunk || typeof chunk !== 'object') return [];
    const candidate = chunk as Record<string, unknown>;
    if (typeof candidate.index !== 'number' || typeof candidate.path !== 'string') return [];
    return [{ index: candidate.index, path: candidate.path }];
  });
}
