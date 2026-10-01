import fs from 'node:fs';
import type { OwnerIdentity } from '@agent-device/host-kit/process';
import { publishFileSync } from '@agent-device/host-kit/file';
import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import { isAgentDeviceDaemonProcess } from '../../daemon-process.ts';
import { readRegisteredDaemonOwnership } from '../daemon-registration.ts';

export { readVersion } from '@agent-device/host-kit/version';
export { readProcessStartTime, type OwnerIdentity } from '@agent-device/host-kit/process';
export {
  type DaemonCodeOrigin,
  resolveDaemonCodeOrigin,
  resolveDaemonCodeSignature,
} from '@agent-device/host-kit/code-signature';

export type DaemonLockInfo = {
  pid: number;
  version: string;
  startedAt: number;
  processStartTime?: string;
};

export function writeInfo(
  baseDir: string,
  infoPath: string,
  logPath: string,
  opts: {
    socketPort?: number;
    httpPort?: number;
    token: string;
    version: string;
    codeOrigin: DaemonCodeOrigin;
    codeSignature: string;
    processStartTime: string | undefined;
    policyDigest?: string;
  },
): void {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(logPath, '');
  const transport = opts.socketPort && opts.httpPort ? 'dual' : opts.httpPort ? 'http' : 'socket';
  // Published through a same-directory temp sibling: a client that reads `daemon.json` while this
  // daemon is starting either sees the previous record or this one, never a half-written file it
  // would have to decode as naming no owner.
  publishFileSync({
    destination: infoPath,
    contents: JSON.stringify(
      {
        port: opts.socketPort,
        httpPort: opts.httpPort,
        transport,
        token: opts.token,
        pid: process.pid,
        version: opts.version,
        codeOrigin: opts.codeOrigin,
        codeSignature: opts.codeSignature,
        processStartTime: opts.processStartTime,
        policyDigest: opts.policyDigest,
        stateDir: baseDir,
      },
      null,
      2,
    ),
    mode: 0o600,
  });
}

export type InfoRemoval =
  | Readonly<{ removed: true }>
  | Readonly<{
      removed: false;
      reason: 'replaced' | 'absent' | 'unreadable' | 'decodable';
      registeredPid?: number;
    }>;

/**
 * Removes `daemon.json` only while it still names `owner`, which is the rule {@link
 * releaseDaemonLock} already applies to the lock next to it: a shutdown that unlinks whatever file is
 * present takes the metadata of the daemon now serving clients (#3087). The record is re-read here
 * rather than trusted from publication, because a successor that took this state dir makes anything
 * this process remembered about the file stale.
 */
export function removeInfoOwnedBy(infoPath: string, owner: OwnerIdentity): InfoRemoval {
  const ownership = readRegisteredDaemonOwnership(infoPath, owner);
  if (ownership.state !== 'match') {
    return {
      removed: false,
      reason: ownership.state,
      ...(ownership.state === 'replaced' ? { registeredPid: ownership.identity.pid } : {}),
    };
  }
  try {
    fs.unlinkSync(infoPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { removed: true };
}

function readLockInfo(lockPath: string): DaemonLockInfo | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as DaemonLockInfo;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function acquireDaemonLock(
  baseDir: string,
  lockPath: string,
  lockData: DaemonLockInfo,
): boolean {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const payload = JSON.stringify(lockData, null, 2);

  const tryWriteLock = (): boolean => {
    try {
      fs.writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  if (tryWriteLock()) return true;
  const existing = readLockInfo(lockPath);
  if (
    existing?.pid &&
    existing.pid !== process.pid &&
    isAgentDeviceDaemonProcess(existing.pid, existing.processStartTime)
  ) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {}
  return tryWriteLock();
}

export function releaseDaemonLock(lockPath: string): void {
  const existing = readLockInfo(lockPath);
  if (existing && existing.pid !== process.pid) return;
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {}
}

export function parseIntegerEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) return undefined;
  return value;
}
