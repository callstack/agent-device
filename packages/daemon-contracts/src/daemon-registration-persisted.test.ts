import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from './daemon-resolution.ts';
import { tryAcquireDaemonRegistration } from './daemon-registration-owner.ts';

const host = vi.hoisted(() => ({ token: '' }));
vi.mock('@agent-device/host-kit/process', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/process')>()),
  readCurrentOwnerIdentity: () => ({ pid: process.pid, startTime: host.token }),
}));

test.each([
  ['Linux linux:boot:123', 'linux:boot:123', 'linux:boot:123'],
  ['Windows', '202611171942270000000', '202611171942270000000'],
])('registration publisher writes the %s legacy field', async (_name, token, legacy) => {
  host.token = token;
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
