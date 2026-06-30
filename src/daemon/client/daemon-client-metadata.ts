import fs from 'node:fs';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import {
  isAgentDeviceDaemonProcess,
  stopProcessForTakeover,
} from '../../utils/process-identity.ts';
import { shellQuote } from '../../utils/shell-quote.ts';
import { resolveDaemonPaths, type DaemonPaths, type DaemonServerMode } from '../config.ts';

export type DaemonInfo = {
  port?: number;
  httpPort?: number;
  transport?: DaemonServerMode;
  token: string;
  pid: number;
  version?: string;
  codeSignature?: string;
  processStartTime?: string;
  baseUrl?: string;
};

type DaemonLockInfo = {
  pid: number;
  processStartTime?: string;
  startedAt?: number;
};

export type DaemonMetadataState = {
  hasInfo: boolean;
  hasLock: boolean;
};

type DaemonStartupCleanupReason = 'start_error' | 'startup_timeout';

export type DaemonStartupCleanupResult = {
  reason: DaemonStartupCleanupReason;
  removedInfo: boolean;
  removedLock: boolean;
  stoppedInfoProcess: boolean;
  stoppedLockProcess: boolean;
  retainedInfoProcess?: boolean;
  retainedLockProcess?: boolean;
  error?: string;
};

const DAEMON_TAKEOVER_TERM_TIMEOUT_MS = 3000;
const DAEMON_TAKEOVER_KILL_TIMEOUT_MS = 1000;

export function readDaemonInfo(infoPath: string): DaemonInfo | null {
  const data = readJsonFile(infoPath);
  if (!data || typeof data !== 'object') return null;
  const parsed = data as Partial<DaemonInfo>;
  const token = readRequiredDaemonToken(parsed);
  if (!token) return null;
  const ports = readDaemonInfoPorts(parsed);
  if (!ports) return null;
  return {
    token,
    ...ports,
    transport: readDaemonInfoTransport(parsed.transport),
    pid: readPositiveInteger(parsed.pid) ?? 0,
    version: readOptionalString(parsed.version),
    codeSignature: readOptionalString(parsed.codeSignature),
    processStartTime: readOptionalString(parsed.processStartTime),
  };
}

function readRequiredDaemonToken(parsed: Partial<DaemonInfo>): string | null {
  return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
}

function readDaemonInfoPorts(
  parsed: Partial<DaemonInfo>,
): Pick<DaemonInfo, 'port' | 'httpPort'> | null {
  const port = readPositiveInteger(parsed.port);
  const httpPort = readPositiveInteger(parsed.httpPort);
  if (port === undefined && httpPort === undefined) return null;
  return { port, httpPort };
}

function readDaemonInfoTransport(value: unknown): DaemonInfo['transport'] {
  return value === 'socket' || value === 'http' || value === 'dual' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function readDaemonLockInfo(lockPath: string): DaemonLockInfo | null {
  const data = readJsonFile(lockPath);
  if (!data || typeof data !== 'object') return null;
  const parsed = data as Partial<DaemonLockInfo>;
  const hasPid = Number.isInteger(parsed.pid) && Number(parsed.pid) > 0;
  if (!hasPid) {
    return null;
  }
  return {
    pid: Number(parsed.pid),
    processStartTime:
      typeof parsed.processStartTime === 'string' ? parsed.processStartTime : undefined,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined,
  };
}

export function removeDaemonInfo(infoPath: string): void {
  removeFileIfExists(infoPath);
}

export function removeDaemonLock(lockPath: string): void {
  removeFileIfExists(lockPath);
}

export function cleanupStaleDaemonLockIfSafe(paths: DaemonPaths): void {
  const state = getDaemonMetadataState(paths);
  if (!state.hasLock || state.hasInfo) return;
  const lockInfo = readDaemonLockInfo(paths.lockPath);
  if (!lockInfo) {
    removeDaemonLock(paths.lockPath);
    return;
  }
  if (isAgentDeviceDaemonProcess(lockInfo.pid, lockInfo.processStartTime)) {
    return;
  }
  removeDaemonLock(paths.lockPath);
}

export async function cleanupFailedDaemonStartupMetadata(
  paths: DaemonPaths,
  reason: DaemonStartupCleanupReason,
  options: { stopLiveProcesses?: boolean } = {},
): Promise<DaemonStartupCleanupResult> {
  const stopLiveProcesses = options.stopLiveProcesses ?? true;
  const result: DaemonStartupCleanupResult = {
    reason,
    removedInfo: false,
    removedLock: false,
    stoppedInfoProcess: false,
    stoppedLockProcess: false,
  };

  try {
    const infoExists = fs.existsSync(paths.infoPath);
    const info = readDaemonInfo(paths.infoPath);
    if (info) {
      const liveInfoProcess = isAgentDeviceDaemonProcess(info.pid, info.processStartTime);
      if (liveInfoProcess && !stopLiveProcesses) {
        result.retainedInfoProcess = true;
      } else {
        if (liveInfoProcess) {
          await stopDaemonProcessForTakeover(info);
          result.stoppedInfoProcess = true;
        }
        removeDaemonInfo(paths.infoPath);
        result.removedInfo = true;
      }
    } else if (infoExists) {
      removeDaemonInfo(paths.infoPath);
      result.removedInfo = true;
    }

    const lockExists = fs.existsSync(paths.lockPath);
    const lockInfo = readDaemonLockInfo(paths.lockPath);
    if (lockInfo) {
      const liveLockProcess = isAgentDeviceDaemonProcess(lockInfo.pid, lockInfo.processStartTime);
      if (liveLockProcess && !stopLiveProcesses) {
        result.retainedLockProcess = true;
      } else {
        if (liveLockProcess) {
          await stopProcessForTakeover(lockInfo.pid, {
            termTimeoutMs: DAEMON_TAKEOVER_TERM_TIMEOUT_MS,
            killTimeoutMs: DAEMON_TAKEOVER_KILL_TIMEOUT_MS,
            expectedStartTime: lockInfo.processStartTime,
          });
          result.stoppedLockProcess = true;
        }
        removeDaemonLock(paths.lockPath);
        result.removedLock = true;
      }
    } else if (lockExists) {
      removeDaemonLock(paths.lockPath);
      result.removedLock = true;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  emitDiagnostic({
    level: result.error ? 'warn' : 'info',
    phase: 'daemon_startup_metadata_cleanup',
    data: result,
  });
  return result;
}

export function getDaemonMetadataState(paths: DaemonPaths): DaemonMetadataState {
  return {
    hasInfo: fs.existsSync(paths.infoPath),
    hasLock: fs.existsSync(paths.lockPath),
  };
}

export async function recoverDaemonLockHolder(paths: DaemonPaths): Promise<boolean> {
  const state = getDaemonMetadataState(paths);
  if (!state.hasLock || state.hasInfo) return false;
  const lockInfo = readDaemonLockInfo(paths.lockPath);
  if (!lockInfo) {
    removeDaemonLock(paths.lockPath);
    return true;
  }
  if (!isAgentDeviceDaemonProcess(lockInfo.pid, lockInfo.processStartTime)) {
    removeDaemonLock(paths.lockPath);
    return true;
  }
  return false;
}

export async function stopDaemonProcessForTakeover(info: DaemonInfo): Promise<void> {
  await stopProcessForTakeover(info.pid, {
    termTimeoutMs: DAEMON_TAKEOVER_TERM_TIMEOUT_MS,
    killTimeoutMs: DAEMON_TAKEOVER_KILL_TIMEOUT_MS,
    expectedStartTime: info.processStartTime,
  });
}

export function isRemoteDaemon(info: DaemonInfo): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}

export function resolveDaemonStartupHint(
  state: { hasInfo: boolean; hasLock: boolean },
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'> = resolveDaemonPaths(
    process.env.AGENT_DEVICE_STATE_DIR,
  ),
): string {
  const cleanupCommand = buildDaemonMetadataCleanupCommand(paths);
  if (state.hasLock && !state.hasInfo) {
    return `agent-device attempted to clean stale daemon metadata automatically, but ${paths.lockPath} still exists without ${paths.infoPath}. Retry with --debug; if this persists after confirming no agent-device daemon process is running, run: ${cleanupCommand}`;
  }
  if (state.hasLock && state.hasInfo) {
    return `agent-device attempted to clean stale daemon metadata automatically, but ${paths.infoPath} and ${paths.lockPath} still remain. Retry with --debug; if this persists after confirming no agent-device daemon process is running, run: ${cleanupCommand}`;
  }
  if (state.hasInfo) {
    return `agent-device did not observe reachable daemon metadata after retrying, and ${paths.infoPath} still remains. Stale metadata was cleaned automatically when safe; retry with --debug. If this persists after confirming no agent-device daemon process is running, run: ${cleanupCommand}`;
  }
  return `agent-device did not observe reachable daemon metadata after retrying. Stale metadata was cleaned automatically when safe; retry with --debug and check daemon diagnostics logs. If stale metadata returns after confirming no agent-device daemon process is running, run: ${cleanupCommand}`;
}

function buildDaemonMetadataCleanupCommand(paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'>) {
  return `rm -f ${shellQuote(paths.infoPath)} ${shellQuote(paths.lockPath)}`;
}

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}
