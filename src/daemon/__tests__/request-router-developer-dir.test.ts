import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test.sequential('a request spawns its commands with its own DEVELOPER_DIR, else the daemon one', async () => {
  const seen: string[] = [];
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('agent-device-router-developer-dir-'), 'daemon.log'),
    token: 'test-token',
    sessionStore: makeSessionStore('agent-device-router-developer-dir-store-'),
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => {
        const child = await runCmd(process.execPath, [
          '-e',
          'process.stdout.write(process.env.DEVELOPER_DIR ?? "")',
        ]);
        seen.push(child.stdout);
        return [];
      },
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const devices = (developerDir?: string) =>
    handler({
      token: 'test-token',
      session: 'default',
      command: 'devices',
      positionals: [],
      flags: { platform: 'ios' },
      meta: { requestId: `req-${developerDir ?? 'none'}`, developerDir },
    });

  const saved = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = '/daemon/Developer';
  try {
    await Promise.all([devices('/a/Developer'), devices('/b/Developer'), devices(''), devices()]);
  } finally {
    if (saved === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = saved;
  }
  expect([...seen].sort()).toEqual(['', '/a/Developer', '/b/Developer', '/daemon/Developer']);
});
