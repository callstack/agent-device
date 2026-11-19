import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const host = vi.hoisted(() => ({ token: '', legacy: '' }));
vi.mock('../../packages/host-kit/src/internal/host-process.ts', async (original) => ({
  ...(await original<typeof import('../../packages/host-kit/src/internal/host-process.ts')>()),
  readProcessStartTime: () => host.token,
  readProcessStartTimeRaw: () => host.legacy,
}));

test.each([
  ['Linux linux:boot:123', 'linux:boot:123', 'linux:boot:123'],
  ['POSIX', 'posix:1794944547000', 'mar. 17 nov. 19:42:27 2026'],
  ['Windows', '202611171942270000000', '202611171942270000000'],
])('production publishers preserve the %s legacy field', async (_name, token, legacy) => {
  vi.resetModules();
  host.token = token;
  host.legacy = legacy;
  const { resolveDaemonPaths } = await import('@agent-device/daemon-contracts/daemon-resolution');
  const { tryAcquireDaemonRegistration } =
    await import('@agent-device/daemon-contracts/daemon-registration-owner');
  const paths = resolveDaemonPaths(mkdtempForTestSync('persisted-owner-publisher-'));
  const written: string[] = [];
  const write = fs.writeSync;
  const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
    written.push(data);
    return write(fd, data);
  }) as typeof fs.writeSync);
  let attempt: Awaited<ReturnType<typeof tryAcquireDaemonRegistration>>;
  try {
    attempt = await tryAcquireDaemonRegistration(paths);
  } finally {
    spy.mockRestore();
  }
  expect(attempt.status).toBe('acquired');
  if (attempt.status !== 'acquired') throw new Error('registration was not acquired');
  attempt.owner.publish({
    socketPort: 4210,
    token: 'test',
    version: 'test',
    codeOrigin: 'checkout',
    codeSignature: 'test',
  });
  const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(paths.lockPath, 'owner.json'), 'utf8'));
  const guard = written
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .find((value) => value?.token && value?.pid === process.pid);
  expect(record).toMatchObject({ processStartTime: legacy, processStartTimeToken: token });
  expect(lock).toMatchObject({ startTime: legacy, birthToken: token });
  expect(guard).toMatchObject({ startTime: legacy, birthToken: token });
  const { createDaemonLifecycleAdmission } =
    await import('../../packages/daemon/src/sessions/server/daemon-idle-reap.ts');
  const { buildDaemonLifecycleRequest } =
    await import('@agent-device/daemon-contracts/daemon-resolution');
  const admission = createDaemonLifecycleAdmission({
    token: 'test',
    identity: { pid: process.pid, processStartTime: token },
    sessionStore: { toArray: () => [] },
    leaseRegistry: { listActiveLeases: () => [] },
    inFlightRequestCount: () => 0,
    startingUp: () => false,
    drain: () => {},
    ownership: () => 'detached',
  });
  const request = buildDaemonLifecycleRequest({
    token: 'test',
    fence: { pid: process.pid, processStartTime: record.processStartTime },
    requestId: 'legacy-fence',
  });
  expect(await admission.admit(async () => ({ ok: true }))(request)).toMatchObject({
    ok: true,
    data: { outcome: 'draining' },
  });
  await attempt.owner.finish();
});
