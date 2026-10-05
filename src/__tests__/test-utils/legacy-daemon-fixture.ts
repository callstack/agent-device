import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { stopDaemonProcess } from '../../daemon-process.ts';
import type { DaemonPaths } from '../../daemon-resolution.ts';

// c237027737: server-lifecycle.ts readLockInfo/acquireDaemonLock/releaseDaemonLock.
const legacyLockProtocol = `
function readLockInfo(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
function acquireDaemonLock(baseDir, lockPath, lockData) {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const payload = JSON.stringify(lockData, null, 2);
  const tryWriteLock = () => {
    try {
      fs.writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryWriteLock()) return true;
  const existing = readLockInfo(lockPath);
  if (existing?.pid && existing.pid !== process.pid &&
      isAgentDeviceDaemonProcess(existing.pid, existing.processStartTime)) return false;
  try { fs.unlinkSync(lockPath); } catch {}
  return tryWriteLock();
}
function releaseDaemonLock(lockPath) {
  const existing = readLockInfo(lockPath);
  if (existing && existing.pid !== process.pid) return;
  try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
}
`;

export function spawnLegacyDaemonFixture(paths: DaemonPaths, acquisitionBarrier?: string) {
  const codeDir = path.join(paths.baseDir, 'legacy');
  const entry = path.join(codeDir, 'dist', 'src', 'internal', 'daemon.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(codeDir, 'package.json'), '{"type":"module"}');
  const processUrl = new URL('../../daemon-process.ts', import.meta.url).href;
  const hostProcessUrl = new URL('../../../packages/host-kit/src/process.ts', import.meta.url).href;
  fs.writeFileSync(
    entry,
    `
import fs from 'node:fs';
import { isAgentDeviceDaemonProcess } from ${JSON.stringify(processUrl)};
import { readProcessStartTime } from ${JSON.stringify(hostProcessUrl)};
${legacyLockProtocol}
const paths = ${JSON.stringify(paths)};
const barrier = ${JSON.stringify(acquisitionBarrier)};
if (barrier) {
  fs.writeFileSync(barrier + '.ready-' + process.pid, 'ready');
  while (!fs.existsSync(barrier)) await new Promise(resolve => setTimeout(resolve, 10));
}
const identity = { pid: process.pid, processStartTime: readProcessStartTime(process.pid) };
const acquired = acquireDaemonLock(paths.baseDir, paths.lockPath, {
  ...identity, version: '0.21.20', startedAt: Date.now(),
});
fs.writeFileSync(paths.baseDir + '/legacy-disposition.json', JSON.stringify({ acquired }));
if (!acquired) process.exit(0);
fs.writeFileSync(paths.infoPath, JSON.stringify({ ...identity, port: 4210, token: 'legacy-token', version: '0.21.20' }));
process.on('SIGTERM', () => { releaseDaemonLock(paths.lockPath); process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  const child = runCmdDetachedMonitored(process.execPath, ['--experimental-strip-types', entry]);
  const startTime = readProcessStartTime(child.pid);
  return {
    pid: child.pid,
    exited: child.exited,
    async stop() {
      const result = await stopDaemonProcess(
        { pid: child.pid, startTime },
        { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 2_000 },
      );
      assert.notEqual(result.status, 'retained', JSON.stringify(result));
      await child.exited;
    },
  };
}
