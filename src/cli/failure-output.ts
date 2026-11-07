import fs from 'node:fs';
import { resolveRemoteRequestDiagnosticsPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import type { AppError, DiagnosticsRecordRef, NormalizedError } from '@agent-device/kernel/errors';
import { commandSynopsis, parseRawArgs } from './parser/args.ts';

type LogTailSource = Parameters<typeof failureLogTail>[0];

type HumanErrorPrint = {
  debugTier?: boolean;
  /** The command that failed; an INVALID_ARGS Next step names its synopsis. */
  command?: string | null;
  /** The raw argv of a failed parse, read for the command when `command` is unknown. */
  argv?: string[];
  /** Where the `--debug` log tail printed after the error body comes from. */
  logTail?: LogTailSource;
};

const SYNOPSIS_LIMIT = 160;
const DAEMON_LOG_TAIL_MAX_BYTES = 64_000;

/** Writes a CLI failure to stderr through the summary-line writer. */
export async function printHumanError(
  err: AppError | NormalizedError,
  options: HumanErrorPrint = {},
): Promise<void> {
  const { writeHumanError } = await import('../commands/output/human-error.ts');
  const command = options.command ?? (options.argv ? await failedParseCommand(options.argv) : null);
  const synopsis =
    err.code === 'INVALID_ARGS' && command ? await synopsisForNextStep(command) : undefined;
  const trailer = options.logTail ? failureLogTail(options.logTail) : undefined;
  writeHumanError(err, { debugTier: options.debugTier, synopsis, trailer });
}

async function synopsisForNextStep(command: string): Promise<string | undefined> {
  const synopsis = await commandSynopsis(command);
  if (!synopsis) return undefined;
  return synopsis.length <= SYNOPSIS_LIMIT ? synopsis : `see agent-device help ${command}`;
}

/**
 * The command a failed parse was for. The parse that failed cannot say, so this takes the first
 * positional that names a command; a value of a leading global flag (`--platform ios`) names none.
 */
async function failedParseCommand(argv: string[]): Promise<string | null> {
  try {
    return parseRawArgs(argv).command ?? null;
  } catch {
    for (const token of argv) {
      if (!token.startsWith('-') && (await commandSynopsis(token))) return token;
    }
    return null;
  }
}

/**
 * The evidence `--debug` puts inline in the caller's own log after a failure.
 *
 * For a LOCAL daemon that is the daemon log this process can read. For a REMOTE
 * one that file belongs to another machine (the same reason the live tail does
 * not follow it), so the tail comes from the request record fetched to this host
 * instead — which is what makes a CI job's transcript carry the evidence without
 * a second round trip (#1801).
 */
function failureLogTail(options: {
  daemonBaseUrl: string | undefined;
  daemonPaths: { logPath: string; baseDir: string };
  record: DiagnosticsRecordRef | undefined;
}): string | undefined {
  if (!options.daemonBaseUrl) {
    return logFileTail('daemon log', options.daemonPaths.logPath);
  }
  if (!options.record) return undefined;
  // Recomputed from the locator through the same helper that wrote the copy, so
  // the tail can only ever come from the fetched record (absent when the fetch
  // failed, since nothing was written).
  return logFileTail(
    'remote diagnostics',
    resolveRemoteRequestDiagnosticsPath(options.daemonPaths.baseDir, options.record),
  );
}

function logFileTail(label: string, logPath: string): string | undefined {
  try {
    if (!fs.existsSync(logPath)) return undefined;
    const tail = readTrailingLines(logPath, DAEMON_LOG_TAIL_MAX_BYTES, 200);
    return tail.trim().length > 0 ? `\n[${label}]\n${tail.trimEnd()}` : undefined;
  } catch {
    return undefined;
  }
}

/** The last `maxLines` lines within the file's last `maxBytes` bytes; the daemon log grows unbounded. */
function readTrailingLines(filePath: string, maxBytes: number, maxLines: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A read that starts mid-file starts mid-line (or mid-character); drop that partial line.
    if (length < size) lines.shift();
    return lines.slice(-maxLines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}
