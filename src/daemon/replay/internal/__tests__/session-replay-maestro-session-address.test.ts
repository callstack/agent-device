import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { stringify } from 'yaml';
import { runTypedMaestroReplay } from '../session-replay-maestro-runtime.ts';
import { SessionStore } from '../../../session-store.ts';
import { createReplaySession } from '../../../handlers/session-replay-command.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { maestroScriptSourceBundleFor } from '../../../../__tests__/test-utils/replay-script-source.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest } from '../../../types.ts';

// The Maestro replay route resolves the store key upstream and then validates the session's
// selectors, so its conflict recovery must name that key too — an implicitly cwd-scoped session
// is named `default` but only `--session cwd:<hash>:default` reaches it (#2031/#1394).
const SCOPED_ADDRESS = 'cwd:8bea844ab16aa9b3:default';

test('a typed Maestro selector conflict names the session store key, not "default"', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-address-');
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, `${stringify({ appId: 'com.example.app' })}---\n${stringify([])}`);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeIosSession('default');
  session.sessionScope = { kind: 'cwd', id: '8bea844ab16aa9b3' };
  sessionStore.set(SCOPED_ADDRESS, session);

  const req = {
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [flowPath],
    flags: {
      replayBackend: 'maestro',
      replayScriptSource: await maestroScriptSourceBundleFor(flowPath),
      udid: 'SIM-OTHER',
    },
    meta: { requestId: 'req-maestro-address' },
  } as unknown as DaemonRequest;

  const response = await runTypedMaestroReplay({
    request: req,
    session: createReplaySession(SCOPED_ADDRESS, path.join(root, 'daemon.log'), sessionStore),
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toContain(`Session "${SCOPED_ADDRESS}"`);
  expect(response.error.message).not.toMatch(/Session "default"/);
  expect(response.error.details?.session).toBe(SCOPED_ADDRESS);
  // The recovery hint itself is asserted on the router routes: this route's error projection
  // (`buildTypedMaestroReplayErrorResponse`) spreads only `normalizeError`'s stripped `details`,
  // which no longer carries `hint`, so no hint reaches the caller here at all — a separate defect
  // from the address this case pins.
});
