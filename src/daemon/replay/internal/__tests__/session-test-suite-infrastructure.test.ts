import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonResponse } from '../../../types.ts';
import { handleSessionCommands } from '../../../handlers/__tests__/session-command-harness.ts';
import { expectOkData, makeSessionStore } from './session-test-suite.fixtures.ts';

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(async () => {
    throw new Error('no device runner available in this test');
  }),
}));

test('test --json marks a typed live device claim as infrastructure without retrying', async () => {
  const sessionStore = makeSessionStore();
  const root = mkdtempForTestSync('agent-device-test-suite-live-device-claim-');
  fs.writeFileSync(path.join(root, '01-claim.ad'), 'context platform=macos\nopen "Demo"\n');

  let attempts = 0;
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-live-device-claim' },
      flags: { retries: 3 },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async () => {
      attempts += 1;
      return {
        ok: false,
        error: {
          code: 'DEVICE_IN_USE',
          message: 'macOS device host-macos-local is owned by another session.',
          details: { reason: 'DEVICE_CLAIM_LIVE_OWNER' },
        },
      };
    },
  });

  const json = JSON.parse(JSON.stringify(response)) as DaemonResponse;
  const data = expectOkData(json);
  expect((data.tests as Array<Record<string, unknown>>)[0]).toMatchObject({
    status: 'failed',
    attempts: 1,
    infrastructure: true,
    error: {
      code: 'REPLAY_DIVERGENCE',
      details: { reason: 'DEVICE_CLAIM_LIVE_OWNER' },
    },
  });
  expect(attempts).toBe(1);
  expect(data.executed).toBe(1);
  expect(data.failed).toBe(1);
});

test('test --json retries DEVICE_IN_USE without typed device-claim provenance', async () => {
  const sessionStore = makeSessionStore();
  const root = mkdtempForTestSync('agent-device-test-suite-session-busy-');
  fs.writeFileSync(path.join(root, '01-busy.ad'), 'context platform=macos\nopen "Demo"\n');

  let attempts = 0;
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-session-busy' },
      flags: { retries: 3 },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async () => {
      attempts += 1;
      return {
        ok: false,
        error: {
          code: 'DEVICE_IN_USE',
          message: 'The requested device is busy with another session.',
          retriable: true,
        },
      };
    },
  });

  const json = JSON.parse(JSON.stringify(response)) as DaemonResponse;
  const data = expectOkData(json);
  const result = (data.tests as Array<Record<string, unknown>>)[0];
  expect(result).toMatchObject({
    status: 'failed',
    attempts: 4,
    error: {
      code: 'REPLAY_DIVERGENCE',
      retriable: true,
    },
  });
  expect(result).not.toHaveProperty('infrastructure');
  expect(attempts).toBe(4);
});
