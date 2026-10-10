/**
 * The router redacts an error only for a fill the caller marked sensitive. Another command can
 * register sensitive values too (a Maestro `inputText` does), and its error, including a
 * `logPath` that happens to contain such a value, comes back unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { AppError } from '@agent-device/kernel/errors';
import type { DeviceRuntimeGateway, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeIosAppSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';

const SESSION = 'maestro-input';

const typeText = vi.fn(async (_input: { text: string }) => {
  throw new AppError('COMMAND_FAILED', 'keyboard is not ready');
});

function withTypeText(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): RuntimeFacts<PlatformRuntimeOperations> {
  return { ...facts, operations: { ...facts.operations, typeText: { available: true } } };
}

const typingDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
  inspectFacts: async (device) =>
    withTypeText(await lifecycleDeviceRuntimeGateway.inspectFacts(device)),
  bind: async (request) => {
    const binding = await lifecycleDeviceRuntimeGateway.bind(request);
    return {
      ...binding,
      facts: withTypeText(binding.facts),
      operations: { ...binding.operations, typeText },
    };
  },
  shutdown: async () => {},
};

test('a Maestro replay error comes back unchanged after its inputText registered a short value', async () => {
  const sessionStore = makeSessionStore('agent-device-router-error-redaction-');
  sessionStore.publish(SESSION, makeIosAppSession(SESSION));
  const root = mkdtempForTestSync('agent-device-router-error-redaction-');
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: com.example.app\n---\n- inputText: "1"\n');
  const handler = createRequestHandler({
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: typingDeviceRuntimeGateway,
  });

  const result = await handler({
    token: 'test-token',
    session: SESSION,
    command: 'replay',
    positionals: [flowPath],
    flags: { replayBackend: 'maestro', platform: 'ios' },
    meta: { requestId: 'req-maestro-input-1' },
  });

  expect(typeText).toHaveBeenCalledWith(expect.objectContaining({ text: '1' }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(JSON.stringify(result.error)).not.toContain('[REDACTED]');
  expect(result.error.logPath).toContain('req-maestro-input-1');
  expect(fs.existsSync(result.error.logPath!)).toBe(true);
});
