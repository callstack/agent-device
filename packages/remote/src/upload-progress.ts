import type { EnvMap } from '@agent-device/kernel/source-value';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import { escapeTerminalText } from '@agent-device/kernel/redaction';
import { Transform } from 'node:stream';

const DEFAULT_UPLOAD_PROGRESS_STEP_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPLOAD_PROGRESS_STEP_RATIO = 0.05;

export type UploadProgressStage = 'direct' | 'legacy';

export type UploadProgressEvent =
  | {
      type: 'start' | 'resume';
      stage: UploadProgressStage;
      fileName: string;
      transferredBytes: number;
      totalBytes: number;
    }
  | {
      type: 'progress';
      stage: UploadProgressStage;
      fileName: string;
      transferredBytes: number;
      totalBytes: number;
    }
  | {
      type: 'fallback';
      from: UploadProgressStage;
      to: UploadProgressStage;
      fileName: string;
    };

export type UploadProgressSink = (event: UploadProgressEvent) => void;

export function createUploadProgressTransform(options: {
  stage: UploadProgressStage;
  fileName: string;
  startOffset: number;
  totalBytes: number;
  onProgress?: UploadProgressSink;
}): Transform {
  const { stage, fileName, startOffset, totalBytes, onProgress } = options;
  let transferredBytes = startOffset;
  const stepBytes = uploadProgressStepBytes(totalBytes);
  let nextReportAt = Math.min(totalBytes, startOffset + stepBytes);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferredBytes = Math.min(totalBytes, transferredBytes + chunk.byteLength);
      if (transferredBytes >= nextReportAt) {
        onProgress?.({
          type: 'progress',
          stage,
          fileName,
          transferredBytes,
          totalBytes,
        });
        nextReportAt = Math.min(totalBytes, transferredBytes + stepBytes);
      }
      callback(null, chunk);
    },
  });
}

/**
 * Upload progress for an interactive terminal. With the caller's progress sink (the CLI passes its own, which escapes
 * what it renders), each event goes there as a command progress line; without one, it is written to stderr escaped.
 */
export function createStderrUploadProgressReporter(
  env: Readonly<EnvMap>,
  onProgress?: RequestProgressSink,
): UploadProgressSink | undefined {
  if (process.stderr.isTTY !== true || env.CI) return undefined;
  return (event) => {
    const message = formatUploadProgressEvent(event);
    if (onProgress) onProgress({ type: 'command', status: 'progress', message });
    else process.stderr.write(`${escapeTerminalText(message)}\n`);
  };
}

function formatUploadProgressEvent(event: UploadProgressEvent): string {
  switch (event.type) {
    case 'start':
      return `Uploading ${event.fileName} (${formatBytes(event.totalBytes)}) via ${formatStage(event.stage)} upload`;
    case 'resume':
      return `Resuming ${event.fileName} at ${formatBytes(event.transferredBytes)} of ${formatBytes(
        event.totalBytes,
      )}`;
    case 'progress':
      return `Uploaded ${formatBytes(event.transferredBytes)} of ${formatBytes(
        event.totalBytes,
      )} (${formatPercent(event.transferredBytes, event.totalBytes)})`;
    case 'fallback':
      return `Direct upload did not complete; retrying ${event.fileName} with ${formatStage(
        event.to,
      )} upload`;
  }
}

function uploadProgressStepBytes(totalBytes: number): number {
  return Math.max(
    DEFAULT_UPLOAD_PROGRESS_STEP_BYTES,
    Math.ceil(totalBytes * DEFAULT_UPLOAD_PROGRESS_STEP_RATIO),
  );
}

function formatStage(stage: UploadProgressStage): string {
  return stage === 'direct' ? 'direct' : 'legacy';
}

function formatPercent(transferredBytes: number, totalBytes: number): string {
  if (totalBytes <= 0) return '100%';
  return `${Math.min(100, Math.floor((transferredBytes / totalBytes) * 100))}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}
