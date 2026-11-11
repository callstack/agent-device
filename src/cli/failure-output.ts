import fs from 'node:fs';
import { formatHumanError } from '@agent-device/command-output';
import { resolveRemoteRequestDiagnosticsPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  AppError,
  type DiagnosticsRecordRef,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { commandSynopsis, parseRawArgs } from './parser/args.ts';

/** Where the `--debug` log tail printed after a failure comes from. */
export type FailureLogSource = {
  daemonBaseUrl: string | undefined;
  daemonPaths: { logPath: string; baseDir: string };
  record: DiagnosticsRecordRef | undefined;
};

type PrintHumanErrorOptions = {
  /** The `--debug`/`--verbose` tier: the raw details dump and the log tail. */
  debugTier?: boolean;
  /** The command that failed; an INVALID_ARGS Next step names its synopsis. */
  command?: string | null;
  /** The raw argv of a failed parse, read for the command when `command` is unknown. */
  argv?: string[];
  logTail?: FailureLogSource;
};

const SYNOPSIS_LIMIT = 160;
const DAEMON_LOG_TAIL_MAX_BYTES = 64_000;

/**
 * Writes a CLI failure to stderr. The summary line opens the block and, when anything follows it,
 * closes it too: callers that merge streams and keep only the first or the last line still read
 * the code, the message, the dispatch fact and the Next step.
 */
export async function printHumanError(
  err: AppError | NormalizedError,
  options: PrintHumanErrorOptions = {},
): Promise<void> {
  const command = options.command ?? (options.argv ? failedParseCommand(options.argv) : null);
  const synopsis =
    err.code === 'INVALID_ARGS' && command ? await synopsisForNextStep(command) : undefined;
  const { summary, body } = formatHumanError(err, { showDetails: options.debugTier, synopsis });
  const trailer = options.logTail ? failureLogTail(options.logTail) : undefined;
  const lines = [summary, ...body, ...(trailer ? [trailer] : [])];
  if (lines.length > 1) lines.push(summary);
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
}

async function synopsisForNextStep(command: string): Promise<string | undefined> {
  const synopsis = await commandSynopsis(command);
  if (!synopsis) return undefined;
  return synopsis.length <= SYNOPSIS_LIMIT ? synopsis : `see agent-device help ${command}`;
}

/**
 * The command a failed parse was for: the command of the longest argv prefix the real parser
 * accepts, so a flag value (`--session press`) is never taken for a command. `null` when no prefix
 * names one.
 */
function failedParseCommand(argv: string[]): string | null {
  for (let end = argv.length; end > 0; end -= 1) {
    try {
      return parseRawArgs(argv.slice(0, end)).command;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }
  return null;
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
function failureLogTail(options: FailureLogSource): string | undefined {
  try {
    if (!options.daemonBaseUrl) {
      return logFileTail('daemon log', options.daemonPaths.logPath);
    }
    if (!options.record) return undefined;
    return logFileTail(
      'remote diagnostics',
      resolveRemoteRequestDiagnosticsPath(options.daemonPaths.baseDir, options.record),
    );
  } catch {
    return undefined;
  }
}

function logFileTail(label: string, logPath: string): string | undefined {
  if (!fs.existsSync(logPath)) return undefined;
  const tail = readTrailingLines(logPath, DAEMON_LOG_TAIL_MAX_BYTES, 200);
  return tail.trim().length > 0 ? `\n[${label}]\n${tail.trimEnd()}` : undefined;
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
