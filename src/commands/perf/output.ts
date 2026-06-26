import type { CommandRequestResult } from '../../client-types.ts';
import { isRecord } from '../../utils/parsing.ts';
import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';

function perfCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  return { data, text: formatPerfCliOutput(data) };
}

export const perfCliOutputFormatters = {
  perf: resultOutput(perfCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function formatPerfCliOutput(data: Record<string, unknown>): string {
  const nativeOutput = formatNativePerfOutput(data);
  if (nativeOutput) return nativeOutput;
  const artifact = isRecord(data.artifact) ? data.artifact : undefined;
  if (artifact) {
    return formatMemoryArtifactSummary(artifact);
  }
  const metrics = isRecord(data.metrics) ? data.metrics : undefined;
  return formatFramePerfOutput(metrics);
}

function formatFramePerfOutput(metrics: Record<string, unknown> | undefined): string {
  const fps = isRecord(metrics?.fps) ? metrics.fps : undefined;
  const resourceSummary = buildResourcePerfSummary(metrics);
  if (!fps) {
    return formatPerfUnavailable(resourceSummary, 'missing frame metric');
  }

  if (fps.available === false) {
    return formatPerfUnavailable(resourceSummary, readUnavailableReason(fps));
  }

  const frameSummary = formatFrameHealthSummary(fps);
  if (!frameSummary) return formatPerfUnavailable(resourceSummary, 'missing dropped-frame summary');

  return formatFrameHealthOutput(fps, frameSummary);
}

function formatFrameHealthOutput(fps: Record<string, unknown>, frameSummary: string): string {
  const lines = [`Frame health: ${frameSummary}`];
  const worstWindows = formatWorstFrameWindows(fps);
  if (worstWindows.length > 0) {
    lines.push('Worst windows:', ...worstWindows);
  }
  return lines.join('\n');
}

function formatMemoryArtifactSummary(artifact: Record<string, unknown>): string {
  const kind = typeof artifact.kind === 'string' ? artifact.kind : 'memory';
  if (artifact.available === false) {
    const reason =
      typeof artifact.reason === 'string' && artifact.reason.length > 0
        ? artifact.reason
        : 'not available';
    return `Memory artifact (${kind}): unavailable - ${reason}`;
  }
  const artifactPath = typeof artifact.path === 'string' ? artifact.path : undefined;
  const sizeBytes = readFiniteNumber(artifact.sizeBytes);
  const sizeText = sizeBytes === undefined ? '' : ` (${formatBytes(sizeBytes)})`;
  return artifactPath
    ? `Memory artifact (${kind}): ${artifactPath}${sizeText}`
    : `Memory artifact (${kind}): captured${sizeText}`;
}

function formatNativePerfOutput(data: Record<string, unknown>): string | undefined {
  if (data.kind === 'xctrace') return formatAppleNativePerfOutput(data);
  return formatAndroidNativePerfOutput(data);
}

function formatAppleNativePerfOutput(data: Record<string, unknown>): string | undefined {
  const state = typeof data.perf === 'string' ? data.perf : undefined;
  const outPath = readNativePerfArtifactPath(data);
  if (!state || !outPath || data.kind !== 'xctrace') return undefined;
  const mode = typeof data.mode === 'string' ? data.mode : 'capture';
  return formatNativePerfLines(outPath, mode, state, data.template);
}

function readNativePerfArtifactPath(data: Record<string, unknown>): string | undefined {
  if (typeof data.outPath === 'string') return data.outPath;
  return typeof data.reportPath === 'string' ? data.reportPath : undefined;
}

function formatNativePerfLines(
  outPath: string,
  mode: string,
  state: string,
  template: unknown,
): string {
  const lines = [outPath, `Perf ${mode}: ${state}`];
  if (typeof template === 'string') lines.push(`Template: ${template}`);
  return lines.join('\n');
}

function formatAndroidNativePerfOutput(data: Record<string, unknown>): string | undefined {
  const summary = readNativePerfSummary(data);
  if (!summary) return undefined;
  return `Perf ${summary.action}: ${summary.kind} ${summary.type}${formatNativePerfState(
    data,
  )}${formatNativePerfArtifact(data)}${formatNativePerfFrameHealth(data)}`;
}

function readNativePerfSummary(
  data: Record<string, unknown>,
): { action: string; kind: string; type: string } | undefined {
  const action = readString(data.action);
  const kind = readString(data.kind);
  const type = readString(data.type);
  return action && kind && type ? { action, kind, type } : undefined;
}

function formatNativePerfState(data: Record<string, unknown>): string {
  const state = readString(data.state);
  return state ? ` state=${state}` : '';
}

function formatNativePerfArtifact(data: Record<string, unknown>): string {
  const outPath = readString(data.outPath);
  if (!outPath) return '';
  const sizeBytes = readFiniteNumber(data.sizeBytes);
  return `\n${outPath}${sizeBytes !== undefined ? ` (${formatBytes(sizeBytes)})` : ''}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatNativePerfFrameHealth(data: Record<string, unknown>): string {
  const summary = isRecord(data.summary) ? data.summary : undefined;
  const frameHealth = isRecord(summary?.frameHealth) ? summary.frameHealth : undefined;
  if (!frameHealth || frameHealth.available !== true) return '';
  const droppedFramePercent = readFiniteNumber(frameHealth.droppedFramePercent);
  const droppedFrameCount = readFiniteNumber(frameHealth.droppedFrameCount);
  const totalFrameCount = readFiniteNumber(frameHealth.totalFrameCount);
  if (
    droppedFramePercent === undefined ||
    droppedFrameCount === undefined ||
    totalFrameCount === undefined
  ) {
    return '';
  }
  return `\nTrace frame health: dropped ${formatPercent(droppedFramePercent)} (${Math.round(
    droppedFrameCount,
  )}/${Math.round(totalFrameCount)} frames)`;
}

function formatPerfUnavailable(resourceSummary: string | undefined, reason: string): string {
  return resourceSummary
    ? `Performance: ${resourceSummary}`
    : `Frame health: unavailable - ${reason}`;
}

function readUnavailableReason(fps: Record<string, unknown>): string {
  return typeof fps.reason === 'string' && fps.reason.length > 0 ? fps.reason : 'not available';
}

function formatFrameHealthSummary(fps: Record<string, unknown>): string | undefined {
  const droppedFramePercent = readFiniteNumber(fps.droppedFramePercent);
  const droppedFrameCount = readFiniteNumber(fps.droppedFrameCount);
  if (droppedFramePercent === undefined || droppedFrameCount === undefined) return undefined;
  return [
    `dropped ${formatPercent(droppedFramePercent)}`,
    formatDroppedFrameCount(droppedFrameCount, readFiniteNumber(fps.totalFrameCount)),
    formatSampleWindow(readFiniteNumber(fps.sampleWindowMs)),
  ]
    .filter(Boolean)
    .join(' ');
}

function formatDroppedFrameCount(droppedFrameCount: number, totalFrameCount?: number): string {
  return totalFrameCount !== undefined
    ? `(${Math.round(droppedFrameCount)}/${Math.round(totalFrameCount)} frames)`
    : `(${Math.round(droppedFrameCount)} dropped frames)`;
}

function formatSampleWindow(sampleWindowMs: number | undefined): string {
  return sampleWindowMs !== undefined ? `window ${formatDurationMs(sampleWindowMs)}` : '';
}

function formatWorstFrameWindows(fps: Record<string, unknown>): string[] {
  if (!Array.isArray(fps.worstWindows)) return [];
  return fps.worstWindows.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const line = formatWorstFrameWindow(entry);
    return line ? [line] : [];
  });
}

function formatWorstFrameWindow(window: Record<string, unknown>): string | undefined {
  const startOffsetMs = readFiniteNumber(window.startOffsetMs);
  const endOffsetMs = readFiniteNumber(window.endOffsetMs);
  const count = readFiniteNumber(window.missedDeadlineFrameCount);
  if (startOffsetMs === undefined || endOffsetMs === undefined || count === undefined) {
    return undefined;
  }
  const worstFrameMs = readFiniteNumber(window.worstFrameMs);
  const worstFrameText =
    worstFrameMs === undefined ? '' : `, worst ${formatDurationMs(worstFrameMs)}`;
  return `- +${formatDurationMs(startOffsetMs)}-+${formatDurationMs(endOffsetMs)}: ${Math.round(count)} missed-deadline frames${worstFrameText}`;
}

function buildResourcePerfSummary(
  metrics: Record<string, unknown> | undefined,
): string | undefined {
  const cpu = isRecord(metrics?.cpu) ? metrics.cpu : undefined;
  const memory = isRecord(metrics?.memory) ? metrics.memory : undefined;
  const parts = [formatCpuPerfSummary(cpu), formatMemoryPerfSummary(memory)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function formatCpuPerfSummary(cpu: Record<string, unknown> | undefined): string | undefined {
  if (cpu?.available !== true) return undefined;
  const usagePercent = readFiniteNumber(cpu.usagePercent);
  return usagePercent !== undefined ? `CPU ${formatPercent(usagePercent)}` : undefined;
}

function formatMemoryPerfSummary(memory: Record<string, unknown> | undefined): string | undefined {
  if (memory?.available !== true) return undefined;
  const memoryKb =
    readFiniteNumber(memory.residentMemoryKb) ??
    readFiniteNumber(memory.totalPssKb) ??
    readFiniteNumber(memory.totalRssKb);
  return memoryKb !== undefined ? `memory ${formatMemoryKb(memoryKb)}` : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formatDurationMs(value: number): string {
  const roundedMs = Math.max(0, Math.round(value));
  if (roundedMs < 1000) return `${roundedMs}ms`;
  const seconds = Math.round(roundedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function formatMemoryKb(value: number): string {
  const megabytes = value / 1024;
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)}MB`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)}B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib >= 10 ? Math.round(kib) : kib.toFixed(1)}KB`;
  const mib = kib / 1024;
  return `${mib >= 10 ? Math.round(mib) : mib.toFixed(1)}MB`;
}
