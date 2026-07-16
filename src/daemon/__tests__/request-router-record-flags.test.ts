/**
 * #1271 stage 2 (ADR 0012 amendment): `--record` and `--no-record` express
 * opposite recording intents for the same action, so both together is
 * rejected uniformly for every surface (CLI/Node client/MCP all funnel
 * through this same request entry point) — before any session/device work,
 * so no session or device setup is needed to exercise it.
 */
import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { createRequestHandler } from '../request-router.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

function createHandler() {
  return createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore: makeSessionStore('agent-device-router-record-flags-'),
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

test('--record and --no-record together are rejected as INVALID_ARGS before any command runs', async () => {
  const handler = createHandler();
  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'get',
    positionals: ['attrs', '@e1'],
    flags: { record: true, noRecord: true },
  });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/--record/);
  expect(response.error.message).toMatch(/mutually exclusive/);
});

test('--record alone is accepted (rejected only by the pairing, not the flag itself)', async () => {
  const handler = createHandler();
  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'get',
    positionals: ['attrs', '@e1'],
    flags: { record: true },
  });
  // No active session for this ref-based get — fails downstream, but NOT on
  // the mutual-exclusivity check.
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).not.toMatch(/mutually exclusive/);
});
