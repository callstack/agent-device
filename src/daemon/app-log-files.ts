import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { lstatIfPresent, NOT_REGULAR_FILE_HINT } from '@agent-device/host-kit/file';

const DEFAULT_MAX_APP_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 1;

export type AppLogRotationConfig = Readonly<{
  maxBytes: number;
  maxRotatedFiles: number;
}>;

/** Shared lower-level file policy for daemon markers and runtime output sinks. */
export function ensureAppLogPath(outPath: string, env: NodeJS.ProcessEnv = process.env): void {
  const directory = path.dirname(outPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  assertAppLogFileIsNotSymbolicLink(outPath);
  rotateAppLogIfNeeded(outPath, {
    maxBytes: positiveIntEnv(env.AGENT_DEVICE_APP_LOG_MAX_BYTES, DEFAULT_MAX_APP_LOG_BYTES),
    maxRotatedFiles: positiveIntEnv(env.AGENT_DEVICE_APP_LOG_MAX_FILES, DEFAULT_MAX_ROTATED_FILES),
  });
}

export function rotateAppLogIfNeeded(outPath: string, config: AppLogRotationConfig): void {
  const current = lstatAppLogFile(outPath);
  if (!current || current.size < config.maxBytes) return;
  for (let index = config.maxRotatedFiles; index >= 1; index -= 1) {
    const from = index === 1 ? outPath : `${outPath}.${index - 1}`;
    const to = `${outPath}.${index}`;
    if (!lstatAppLogFile(from)) continue;
    if (lstatAppLogFile(to)) fs.unlinkSync(to);
    fs.renameSync(from, to);
  }
}

function assertAppLogFileIsNotSymbolicLink(outPath: string): void {
  void lstatAppLogFile(outPath);
}

function lstatAppLogFile(outPath: string): fs.Stats | undefined {
  const stats = lstatIfPresent(outPath);
  if (stats?.isSymbolicLink()) {
    throw new AppError('COMMAND_FAILED', `App-log file must not be a symbolic link: ${outPath}`, {
      hint: NOT_REGULAR_FILE_HINT,
    });
  }
  return stats;
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
