import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { makeSessionStore } from '../../__tests__/test-utils/index.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from '../request-router.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

function createHarness() {
  const root = mkdtempForTestSync('agent-device-router-replay-env-');
  return {
    root,
    handler: createRequestHandler({
      logPath: path.join(root, 'daemon.log'),
      stateDir: root,
      token: 'test-token',
      sessionStore: makeSessionStore('agent-device-router-replay-env-store-'),
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    }),
  };
}

test('malformed replay env returns a normalized INVALID_ARGS response', async () => {
  const { root, handler } = createHarness();
  const flowPath = path.join(root, 'flow.ad');
  fs.writeFileSync(flowPath, 'wait 1\n');

  await expect(
    handler({
      token: 'test-token',
      session: 'default',
      command: 'replay',
      positionals: [flowPath],
      flags: { replayEnv: ['NOEQUAL'] },
      meta: { requestId: 'req-invalid-replay-env' },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: expect.stringContaining('expected KEY=VALUE'),
    },
  });
});

test('ordinary replay env values do not globally corrupt request diagnostics', async () => {
  const { root, handler } = createHarness();
  const missingPath = path.join(root, '2-missing.ad');

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [missingPath],
    flags: { replayEnv: ['RETRIES=2', 'USER=demo'] },
    meta: { requestId: 'req-ordinary-replay-env' },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.logPath).toBeTruthy();
  const diagnostics = fs.readFileSync(response.error.logPath!, 'utf8');
  expect(diagnostics).toContain(missingPath);
  expect(diagnostics).not.toContain('[REDACTED]-missing.ad');
  for (const line of diagnostics.trim().split('\n')) {
    const event = JSON.parse(line) as { ts: string };
    expect(event.ts).not.toContain('[REDACTED]');
  }
});
