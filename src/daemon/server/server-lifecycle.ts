import fs from 'node:fs';
import { isAgentDeviceDaemonProcess } from '../../utils/process-identity.ts';

export { readVersion } from '../../utils/version.ts';
export { readProcessStartTime } from '../../utils/process-identity.ts';
export { resolveDaemonCodeSignature } from '../code-signature.ts';

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
    codeSignature: string;
    processStartTime: string | undefined;
  },
): void {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(logPath, '');
  const transport = opts.socketPort && opts.httpPort ? 'dual' : opts.httpPort ? 'http' : 'socket';
  fs.writeFileSync(
    infoPath,
    JSON.stringify(
      {
        port: opts.socketPort,
        httpPort: opts.httpPort,
        transport,
        token: opts.token,
        pid: process.pid,
        version: opts.version,
        codeSignature: opts.codeSignature,
        processStartTime: opts.processStartTime,
        stateDir: baseDir,
      },
      null,
      2,
    ),
    {
      mode: 0o600,
    },
  );
  // writeFileSync only applies mode on creation; tighten pre-existing files too.
  fs.chmodSync(infoPath, 0o600);
}

export function removeInfo(infoPath: string): void {
  if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath);
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
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
