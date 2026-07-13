import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleSessionCommands } from '../session.ts';

test('test --fail-fast continues after passing scripts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-fail-fast-pass-'));
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=ios\nopen "Demo"\n');
  fs.writeFileSync(path.join(root, '02-second.ad'), 'context platform=ios\nopen "Demo"\n');

  const invokedPaths: string[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-fail-fast-pass' },
      flags: { failFast: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore: makeSessionStore('agent-device-test-fail-fast-pass-store-'),
    invoke: async (request) => {
      invokedPaths.push(String(request.positionals?.[0]));
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected successful daemon response.');
  expect(invokedPaths).toHaveLength(2);
  expect(response.data?.total).toBe(2);
  expect(response.data?.executed).toBe(2);
  expect(response.data?.passed).toBe(2);
  expect(response.data?.notRun).toBe(0);
});
