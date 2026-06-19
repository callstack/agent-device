import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDaemonPaths } from '../src/daemon/config.ts';
import {
  isAgentDeviceDaemonProcess,
  stopProcessForTakeover,
} from '../src/utils/process-identity.ts';
import { cleanupRunnerLeasesForOwner } from '../src/platforms/ios/runner-lease.ts';
import { runnerLeaseCleanupAdapter } from '../src/platforms/ios/runner-disposal.ts';

const DAEMON_TERM_TIMEOUT_MS = 15_000;
const DAEMON_KILL_TIMEOUT_MS = 2_000;
const PRUNE_DEV_FLAG = '--prune-dev';
const PRUNE_DEV_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type DaemonInfo = {
  pid?: number;
  processStartTime?: string;
};

const paths = resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR);
const info = readDaemonInfo(paths.infoPath);
const daemonPid = readPositivePid(info?.pid);

if (daemonPid !== null) {
  await stopProcessForTakeover(daemonPid, {
    termTimeoutMs: DAEMON_TERM_TIMEOUT_MS,
    killTimeoutMs: DAEMON_KILL_TIMEOUT_MS,
    expectedStartTime: info?.processStartTime,
  });
  await cleanupRunnerLeasesForOwner(
    { pid: daemonPid, startTime: info?.processStartTime },
    runnerLeaseCleanupAdapter,
  );
}

removeIfPresent(paths.infoPath);
removeIfPresent(paths.lockPath);

if (process.argv.includes(PRUNE_DEV_FLAG)) {
  pruneStaleDevStateDirs();
}

function readDaemonInfo(infoPath: string): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(infoPath, 'utf8')) as DaemonInfo;
  } catch {
    return null;
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

// Removes worktree-scoped state dirs under ~/.agent-device/dev/ that no live daemon
// owns and that have been idle past the retention threshold. Never touches the
// global ~/.agent-device root contents.
function pruneStaleDevStateDirs(): void {
  const devRoot = path.join(os.homedir(), '.agent-device', 'dev');
  const cutoffMs = Date.now() - PRUNE_DEV_MAX_AGE_MS;
  for (const dirPath of listDevStateDirs(devRoot)) {
    if (hasLiveDaemon(dirPath) || newestMtimeMs(dirPath) > cutoffMs) continue;
    fs.rmSync(dirPath, { recursive: true, force: true });
    process.stdout.write(`Removed stale daemon state dir: ${dirPath}\n`);
  }
}

function listDevStateDirs(devRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(devRoot, entry.name));
}

function hasLiveDaemon(stateDir: string): boolean {
  const dirInfo = readDaemonInfo(path.join(stateDir, 'daemon.json'));
  const pid = readPositivePid(dirInfo?.pid);
  return pid !== null && isAgentDeviceDaemonProcess(pid, dirInfo?.processStartTime);
}

function readPositivePid(pid: number | undefined): number | null {
  if (typeof pid !== 'number') return null;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function newestMtimeMs(dirPath: string): number {
  let newest = statMtimeMs(dirPath);
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const child of children) {
    newest = Math.max(newest, statMtimeMs(path.join(dirPath, child.name)));
  }
  return newest;
}

function statMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
