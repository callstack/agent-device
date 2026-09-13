import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { runTypedMaestroReplay } from '../session-replay-maestro-runtime.ts';
import { SessionStore } from '../../../session-store.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { maestroScriptSourceBundleFor } from '../../../../__tests__/test-utils/replay-script-source.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest } from '../../../daemon-request.ts';
import { createReplaySession } from '../../../handlers/session-replay-command.ts';
import * as maestro from '@agent-device/maestro';

const spy = vi.spyOn(maestro, 'executeMaestroFlow');

async function runWithNetworkFlag(publicNetworkOnly: boolean | undefined) {
  const root = mkdtempForTestSync('agent-device-maestro-remote-wire-');
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(
    flowPath,
    ['appId: com.example.app', '---', '- evalScript: ${output.sum = 1 + 2}', ''].join('\n'),
  );
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));

  const req = {
    token: 'test-token',
    session: 'default',
    command: 'replay',
    positionals: [flowPath],
    flags: {
      platform: 'ios',
      replayScriptSource: await maestroScriptSourceBundleFor(flowPath),
    },
    ...(publicNetworkOnly === true ? { internal: { publicNetworkOnly: true } } : {}),
    meta: { requestId: `req-maestro-wire-${publicNetworkOnly}` },
  } as unknown as DaemonRequest;

  spy.mockResolvedValueOnce({ ok: true, replayed: 1, planDigest: 'test', startIndex: 0 } as never);

  const response = await runTypedMaestroReplay({
    request: req,
    session: createReplaySession('default', path.join(root, 'daemon.log'), sessionStore),
    invoke: async () => ({ ok: true, data: {} }) as never,
  });

  expect(response.ok).toBe(true);
  return spy.mock.calls.at(-1)?.[2] as { trustedScripts?: boolean } | undefined;
}

describe('remote Maestro evalScript trust wiring', () => {
  // Proves the remote HTTP surface reaches the engine as trustedScripts:false.
  // The engine side (process/fs/child-process/network/budget matrix in
  // packages/maestro/src/internal/__tests__/engine.test.ts) proves false refuses
  // before vm evaluation — together they prove remote evalScript never runs.
  test('remote HTTP (publicNetworkOnly) forwards trustedScripts:false so the engine refuses before vm', async () => {
    const options = await runWithNetworkFlag(true);
    expect(options?.trustedScripts).toBe(false);
  });

  test('local flow does not forward trustedScripts:false', async () => {
    const options = await runWithNetworkFlag(undefined);
    expect(options?.trustedScripts).not.toBe(false);
  });
});
