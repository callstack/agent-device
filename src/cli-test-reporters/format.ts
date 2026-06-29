import path from 'node:path';
import type { ReplaySuiteTestResult } from '../daemon/types.ts';

export type PassedReplayTestResult = Extract<ReplaySuiteTestResult, { status: 'passed' }>;
export type FailedReplayTestResult = Extract<ReplaySuiteTestResult, { status: 'failed' }>;
export type ReplayTestError = FailedReplayTestResult['error'];

export function getReplayTestExitCode(data: { failed: number }): number {
  return data.failed > 0 ? 1 : 0;
}

export function isFailedReplayTestResult(
  result: ReplaySuiteTestResult,
): result is FailedReplayTestResult {
  return result.status === 'failed';
}

export function isFlakyReplayTestResult(
  result: ReplaySuiteTestResult,
): result is PassedReplayTestResult {
  return result.status === 'passed' && result.attempts > 1;
}

export function replayTestDisplayNameWithFile(result: ReplaySuiteTestResult): string {
  const title = replayTestTitle(result);
  const filename = path.basename(result.file);
  const base = title && title.length > 0 ? title : filename;
  return `${base}${formatReplayTestShardSuffix(result)}`;
}

export function replayTestCaseName(result: ReplaySuiteTestResult): string {
  return `${replayTestTitle(result) ?? path.basename(result.file)}${formatReplayTestShardSuffix(result)}`;
}

export function replayArtifactsLine(
  result: ReplaySuiteTestResult,
  label: 'artifacts' | 'artifactsDir',
): string | undefined {
  return 'artifactsDir' in result && result.artifactsDir
    ? `${label}: ${result.artifactsDir}`
    : undefined;
}

export function replayTestFailureFileLine(result: FailedReplayTestResult): string | undefined {
  return replayTestTitle(result) ? `file: ${path.basename(result.file)}` : undefined;
}

export function replayErrorHintLine(error: ReplayTestError): string | undefined {
  return error.hint ? `hint: ${error.hint}` : undefined;
}

export function replayErrorDiagnosticLine(
  error: ReplayTestError,
  label: 'diagnostic' | 'diagnosticId',
): string | undefined {
  return error.diagnosticId ? `${label}: ${error.diagnosticId}` : undefined;
}

export function replayErrorLogLine(
  error: ReplayTestError,
  label: 'log' | 'logPath',
): string | undefined {
  return error.logPath ? `${label}: ${error.logPath}` : undefined;
}

export function appendReplayErrorMetadata(
  lines: string[],
  error: ReplayTestError,
  options: { includeMessage?: boolean; includeDetails?: boolean; detailsIndent?: number } = {},
): void {
  if (options.includeMessage) lines.push(`errorMessage: ${error.message}`);
  appendOptionalLine(lines, replayErrorHintLine(error));
  appendOptionalLine(lines, replayErrorDiagnosticLine(error, 'diagnosticId'));
  appendOptionalLine(lines, replayErrorLogLine(error, 'logPath'));
  if (options.includeDetails !== false) {
    appendReplayErrorDetails(lines, error, options.detailsIndent);
  }
}

export function appendReplayErrorDetails(
  lines: string[],
  error: ReplayTestError,
  detailsIndent?: number,
): void {
  const details = error.details ? JSON.stringify(error.details, null, detailsIndent) : undefined;
  if (details) lines.push(`details: ${details}`);
}

export function appendReplayTestShardMetadata(
  lines: string[],
  result: ReplaySuiteTestResult,
): void {
  if (!('shardIndex' in result) || typeof result.shardIndex !== 'number') return;
  lines.push(`shardIndex: ${result.shardIndex}`);
  appendOptionalLine(
    lines,
    typeof result.shardCount === 'number' ? `shardCount: ${result.shardCount}` : undefined,
  );
  appendOptionalLine(
    lines,
    typeof result.deviceId === 'string' ? `deviceId: ${result.deviceId}` : undefined,
  );
  appendOptionalLine(
    lines,
    typeof result.deviceName === 'string' ? `deviceName: ${result.deviceName}` : undefined,
  );
}

export function replayTestWarningLines(result: ReplaySuiteTestResult): string[] {
  if (result.status !== 'passed') return [];
  return (result.warnings ?? []).map((warning) => `warning: ${warning}`);
}

export function appendOptionalLine(lines: string[], line: string | undefined): void {
  if (line) lines.push(line);
}

export function formatJUnitSeconds(durationMs: number): string {
  return (Math.max(0, durationMs) / 1000).toFixed(3);
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function isDefinedString(value: string | undefined): value is string {
  return value !== undefined;
}

function replayTestTitle(result: ReplaySuiteTestResult): string | undefined {
  const title = result.title?.trim();
  return title && title.length > 0 ? title : undefined;
}

export function formatReplayTestShardSuffix(result: ReplaySuiteTestResult): string {
  if (!('shardIndex' in result) || typeof result.shardIndex !== 'number') return '';
  const shardCount = typeof result.shardCount === 'number' ? result.shardCount : '?';
  const device = replayTestShardDeviceName(result);
  return ` [${result.shardIndex + 1}/${shardCount}${device ? ` ${device}` : ''}]`;
}

function replayTestShardDeviceName(result: ReplaySuiteTestResult): string | undefined {
  const name = 'deviceName' in result ? result.deviceName?.trim() : undefined;
  if (name) return name;
  const id = 'deviceId' in result ? result.deviceId?.trim() : undefined;
  return id || undefined;
}
