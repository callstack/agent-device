import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runBatch } from '../../sdk/batch.ts';
import type { DaemonRequest } from '@agent-device/kernel/contracts';

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

async function runBatchFailingAtSecondStep(firstCommand: string, firstPositionals: string[]) {
  const req: Omit<DaemonRequest, 'token'> = {
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        { command: firstCommand, positionals: firstPositionals },
        { command: 'press', positionals: ['label=Missing'] },
      ],
    },
  };
  return await runBatch(req, 'session', async (stepReq) =>
    stepReq.positionals?.[0] === 'label=Missing'
      ? {
          ok: false,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            message: 'No element matches label=Missing',
            details: { dispatched: 'no' },
          },
        }
      : { ok: true, data: {} },
  );
}

test('batch reports unknown when a mutating step executed before the refused step', async () => {
  const response = await runBatchFailingAtSecondStep('press', ['label=A']);
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.details?.dispatched, 'unknown');
    assert.equal(response.error.details?.executed, 1);
  }
});

test('batch keeps the refused step verdict when only reads executed before it', async () => {
  const response = await runBatchFailingAtSecondStep('get', ['text', 'label=A']);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.details?.dispatched, 'no');
});

test('batch reports unknown when a step with no declared effect executed before the refused step', async () => {
  const response = await runBatchFailingAtSecondStep('test', ['flow.ad']);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.details?.dispatched, 'unknown');
});

test('batch reports unknown when an undeclared read-only step executed before the refused step', async () => {
  const response = await runBatchFailingAtSecondStep('devices', []);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.details?.dispatched, 'unknown');
});
