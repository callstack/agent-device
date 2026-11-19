import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

const host = vi.hoisted(() => ({ token: '', legacy: '' }));
vi.mock('./host-process.ts', async (original) => ({
  ...(await original<typeof import('./host-process.ts')>()),
  readProcessStartTime: () => host.token,
  readProcessStartTimeRaw: () => host.legacy,
}));

test.each([
  ['Linux linux:boot:123', 'linux:boot:123', 'linux:boot:123'],
  ['POSIX', 'posix:1794944547000', 'mar. 17 nov. 19:42:27 2026'],
  ['Windows', '202611171942270000000', '202611171942270000000'],
])('lock and guard publish the %s legacy field', async (_name, token, legacy) => {
  vi.resetModules();
  host.token = token;
  host.legacy = legacy;
  const { readCurrentOwnerIdentity } = await import('./owner-identity.ts');
  const { tryAcquireProcessLock } = await import('./process-lock.ts');
  const lockDirPath = path.join(mkdtempForTestSync('persisted-lock-'), 'daemon.lock');
  const written: string[] = [];
  const write = fs.writeSync;
  const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
    written.push(data);
    return write(fd, data);
  }) as typeof fs.writeSync);
  let attempt: ReturnType<typeof tryAcquireProcessLock>;
  try {
    attempt = tryAcquireProcessLock({
      lockDirPath,
      owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
    });
  } finally {
    spy.mockRestore();
  }
  expect(attempt.status).toBe('acquired');
  if (attempt.status !== 'acquired') throw new Error('lock was not acquired');
  const lock = JSON.parse(fs.readFileSync(path.join(lockDirPath, 'owner.json'), 'utf8'));
  const guard = written
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .find((value) => value?.token && value?.pid === process.pid);
  expect(lock).toMatchObject({ startTime: legacy, birthToken: token });
  expect(guard).toMatchObject({ startTime: legacy, birthToken: token });
  await attempt.acquisition.release();
});
