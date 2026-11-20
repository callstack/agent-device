import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const host = vi.hoisted(() => ({ token: '', raw: 'Tue Nov 17 19:42:27 2026' }));
vi.mock('../../host-kit/src/internal/host-process.ts', async (original) => ({
  ...(await original<typeof import('../../host-kit/src/internal/host-process.ts')>()),
  readProcessStartTime: () => host.token,
  readProcessStartTimeRaw: () => host.raw,
}));

test.each([
  ['Linux', 'linux:boot:123', 'linux:boot:123'],
  ['POSIX', 'posix:1794944547000', 'Tue Nov 17 19:42:27 2026'],
  ['Windows', '202611171942270000000', '202611171942270000000'],
])('registration publisher writes the %s legacy field', async (_name, token, legacy) => {
  vi.resetModules();
  host.token = token;
  const { resolveDaemonPaths } = await import('./daemon-resolution.ts');
  const { tryAcquireDaemonRegistration } = await import('./daemon-registration-owner.ts');
  const paths = resolveDaemonPaths(mkdtempForTestSync('persisted-registration-'));
  const attempt = await tryAcquireDaemonRegistration(paths);
  expect(attempt.status).toBe('acquired');
  if (attempt.status !== 'acquired') throw new Error('registration was not acquired');
  attempt.owner.publish({
    socketPort: 4210,
    token: 'test',
    version: 'test',
    codeOrigin: 'checkout',
    codeSignature: 'test',
  });
  expect(JSON.parse(fs.readFileSync(paths.infoPath, 'utf8'))).toMatchObject({
    processStartTime: legacy,
    processStartTimeToken: token,
  });
  await attempt.owner.finish();
});
