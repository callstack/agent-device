import fs from 'node:fs';
import path from 'node:path';
import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { isProcessAlive } from '@agent-device/host-kit/process';

/**
 * Startup phase markers: a per-launch record, named for the writing pid, of how far that startup
 * got, so a waiting client tells "slow but progressing" from "stuck" without a heartbeat. The
 * writer removes it on completion, the client after a joined exit, and each new registration
 * owner sweeps the files of provably dead pids.
 */
const DAEMON_STARTUP_PHASES = Object.freeze([
  'modules-loaded',
  'composition-loaded',
  'lock-acquired',
  'recovery-finished',
  'listening',
  'registered',
] as const);

export type DaemonStartupPhase = (typeof DAEMON_STARTUP_PHASES)[number];

const DAEMON_STARTUP_PHASE_SET: ReadonlySet<string> = new Set<string>(DAEMON_STARTUP_PHASES);

const DAEMON_STARTUP_PHASES_ENTRY = /^daemon-startup-phases-(\d*)\.jsonl$/;

/** The marker file the daemon process `pid` writes in `stateDir`; an absent file is no evidence. */
export function resolveDaemonStartupPhasesPath(stateDir: string, pid: number): string {
  return path.join(stateDir, `daemon-startup-phases-${pid}.jsonl`);
}

/** Appends one phase marker; a refused append goes to `reportFailure`, never fatal to a startup. */
export function recordDaemonStartupMarker(
  startupPhasesPath: string,
  phase: DaemonStartupPhase,
  reportFailure?: (error: NormalizedError) => void,
): void {
  try {
    const timestampMs = Date.now();
    fs.mkdirSync(path.dirname(startupPhasesPath), { recursive: true });
    // A crash mid-append can leave no trailing newline; glue two appends and both are lost.
    const separator = endsWithoutNewline(startupPhasesPath) ? '\n' : '';
    fs.appendFileSync(
      startupPhasesPath,
      `${separator}${JSON.stringify({ data: { startupPhase: phase, timestampMs } })}\n`,
    );
  } catch (error) {
    reportFailure?.(normalizeError(error));
  }
}

function endsWithoutNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    const stats = fs.statSync(file);
    if (stats.size === 0) return false;
    const buffer = Buffer.alloc(1);
    fd = fs.openSync(file, 'r');
    if (fs.readSync(fd, buffer, 0, 1, stats.size - 1) !== 1) return false;
    return buffer[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Removes this launch's record: before its first marker (a per-pid name identifies a writer, not
 * a lifetime, so the entry claims its file first), and after a finished startup or joined exit.
 * A refused removal only reports through `reportFailure`; it never stops a startup.
 */
export function removeDaemonStartupPhasesFile(
  startupPhasesPath: string,
  reportFailure?: (error: NormalizedError) => void,
): void {
  try {
    fs.rmSync(startupPhasesPath, { force: true });
  } catch (error) {
    reportFailure?.(normalizeError(error));
  }
}

/** Sweeps marker files of provably dead (or unnameable) pids; a live pid's file is kept. */
export function sweepDeadDaemonStartupPhasesFiles(stateDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = DAEMON_STARTUP_PHASES_ENTRY.exec(entry);
    if (match === null) continue;
    const deadPid = Number(match[1]);
    if (deadPid === process.pid) continue;
    if (!Number.isSafeInteger(deadPid) || deadPid <= 0 || !isProcessAlive(deadPid)) {
      removeDaemonStartupPhasesFile(path.join(stateDir, entry));
    }
  }
}

/**
 * The phases observed in a marker tail, keeping each phase's earliest occurrence. Unknown and
 * unparsable lines are ignored: a client never fails a startup over a line it does not know.
 */
export function readDaemonStartupPhaseMarkers(
  markerTail: string,
): Partial<Record<DaemonStartupPhase, number>> {
  const phases: Partial<Record<DaemonStartupPhase, number>> = {};
  for (const line of markerTail.split('\n')) {
    if (!line.includes('"startupPhase"')) continue;
    let record: DaemonStartupMarkerRecord;
    try {
      record = JSON.parse(line) as DaemonStartupMarkerRecord;
    } catch {
      continue;
    }
    const phase = record.data?.startupPhase;
    const timestampMs = record.data?.timestampMs;
    if (
      typeof phase !== 'string' ||
      !DAEMON_STARTUP_PHASE_SET.has(phase) ||
      typeof timestampMs !== 'number' ||
      !Number.isFinite(timestampMs)
    ) {
      continue;
    }
    const seen = phases[phase as DaemonStartupPhase];
    if (seen === undefined || timestampMs < seen) phases[phase as DaemonStartupPhase] = timestampMs;
  }
  return phases;
}

type DaemonStartupMarkerRecord = {
  data?: { startupPhase?: unknown; timestampMs?: unknown };
};
