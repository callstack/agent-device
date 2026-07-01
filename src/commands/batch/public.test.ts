import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runBatch } from '../../sdk/batch.ts';
import type { DaemonRequest } from '../../kernel/contracts.ts';

test('public batch entrypoint exports daemon-compatible orchestration helpers', async () => {
  const seenCommands: string[] = [];
  const req: Omit<DaemonRequest, 'token'> = {
    command: 'batch',
    positionals: [],
    flags: {
      platform: 'ios',
      udid: 'sim-1',
      batchSteps: [
        { command: 'open', positionals: ['settings'] },
        { command: 'wait', positionals: ['100'], flags: { platform: 'android' } },
      ],
    },
  };

  const response = await runBatch(req, 'resolved-session', async (stepReq) => {
    seenCommands.push(stepReq.command);
    assert.equal(stepReq.session, 'resolved-session');
    assert.equal(stepReq.flags?.session, 'resolved-session');
    if (stepReq.command === 'open') {
      assert.equal(stepReq.flags?.platform, 'ios');
      assert.equal(stepReq.flags?.udid, 'sim-1');
    }
    if (stepReq.command === 'wait') {
      assert.equal(stepReq.flags?.platform, 'android');
    }
    return { ok: true, data: { command: stepReq.command } };
  });

  assert.equal(response.ok, true);
  assert.deepEqual(seenCommands, ['open', 'wait']);
  if (response.ok) {
    assert.equal(response.data.total, 2);
    assert.equal(response.data.results[0]?.command, 'open');
  }
});
