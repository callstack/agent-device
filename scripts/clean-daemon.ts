import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { resolveDaemonPaths } from '../src/daemon-resolution.ts';
import { readRegisteredDaemonIdentity } from '../src/daemon-registration.ts';
import {
  stopAndRetireDaemon,
  recoverAbandonedDaemonRegistration,
} from '../src/daemon-registration-owner.ts';

const DAEMON_TERM_TIMEOUT_MS = 15_000;
const DAEMON_KILL_TIMEOUT_MS = 2_000;
const PRUNE_DEV_FLAG = '--prune-dev';
const PRUNE_DEV_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const paths = resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR);
const retirement = await stopAndRetireDaemon({
  paths,
  observed: readRegisteredDaemonIdentity(paths.infoPath),
  mode: 'graceful',
  termTimeoutMs: DAEMON_TERM_TIMEOUT_MS,
  killTimeoutMs: DAEMON_KILL_TIMEOUT_MS,
});
if (retirement.status === 'retained') {
  throw new AppError(
    'COMMAND_FAILED',
    'Daemon cleanup retained state because retirement could not be confirmed.',
    {
      reason: 'daemon_retirement_unconfirmed',
      retirement,
      hint: retirement.error?.hint,
    },
  );
}
if (retirement.status === 'retired') {
  const { cleanupRunnerLeasesForOwner } =
    await import('@agent-device/platform-apple/runner/operations');
  await cleanupRunnerLeasesForOwner(retirement.termination.identity);
}

if (process.argv.includes(PRUNE_DEV_FLAG)) {
  await pruneStaleDevStateDirs();
}

async function pruneStaleDevStateDirs(): Promise<void> {
  const devRoot = path.join(os.homedir(), '.agent-device', 'dev');
  const cutoffMs = Date.now() - PRUNE_DEV_MAX_AGE_MS;
  for (const dirPath of listDevStateDirs(devRoot)) {
    if (newestMtimeMs(dirPath) > cutoffMs) continue;
    const paths = resolveDaemonPaths(dirPath);
    const result = await recoverAbandonedDaemonRegistration({
      paths,
      observed: readRegisteredDaemonIdentity(paths.infoPath),
    });
    if (result.status === 'retired')
      process.stdout.write(
        `Retired stale daemon registration: ${dirPath} (session artifacts retained)\n`,
      );
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
