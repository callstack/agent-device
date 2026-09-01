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

// A replay error raised before any step runs carries no `failure`, so the route
// projects the normalized error directly instead of through the divergence
// transport. `normalizeError` lifts `hint` (and the other diagnostic meta) OUT
// of `details`, so that projection has to carry the normalized fields — spreading
// only `details` drops every recovery the throw site wrote.
test('a typed Maestro replay error keeps its recovery hint', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-hint-');
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, `${stringify({ appId: 'com.example.app' })}---\n${stringify([])}`);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));

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
    meta: { requestId: 'req-maestro-hint' },
  } as unknown as DaemonRequest;

  const response = await runTypedMaestroReplay({
    request: req,
    session: createReplaySession('default', path.join(root, 'daemon.log'), sessionStore),
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.hint).toContain('agent-device session list');
  expect(response.error.hint).toContain('--session default');
  // The throw site's own details survive beside the projected hint.
  expect(response.error.details?.session).toBe('default');
  expect(response.error.details?.conflicts).toEqual(['--udid=SIM-OTHER']);
  // `hint` is projected, not left behind in `details`.
  expect(response.error.details?.hint).toBeUndefined();
});
