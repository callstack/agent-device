import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliJsonResult } from './cli-json.ts';
import {
  answerDeepLinkConfirmation,
  type DeepLinkConfirmationDevice,
} from './ios-simulator-e2e/live-deep-link-confirmation.ts';

function result(status: number, json?: unknown): CliJsonResult {
  return { json, status, stderr: '', stdout: '' };
}

const LANDED = result(0, { success: true });
const LAUNCH_PENDING = result(1, {
  error: {
    code: 'COMMAND_FAILED',
    details: { reason: 'wait_capture_stalled', runnerErrorCode: 'APP_NOT_RUNNING' },
  },
});
const WRONG_ROUTE = result(1, {
  error: { code: 'COMMAND_FAILED', details: { reason: 'wait_target_absent' } },
});
const READABLE_TIMEOUT = result(1, {
  error: {
    code: 'COMMAND_FAILED',
    details: { reason: 'wait_deadline_exceeded', readableCaptures: 5, captureTruncated: true },
  },
});
const OPEN_PROMPT = result(0, {
  data: { message: 'Open in “Agent Device Tester”?', items: ['Cancel', 'Open'] },
});
const NO_ALERT = result(1, { error: { code: 'COMMAND_FAILED' } });

/** A simulator whose destination waits and alert probes answer in the order given. */
function simulator(destinationWaits: CliJsonResult[], alerts: CliJsonResult[] = [OPEN_PROMPT]) {
  const log: string[] = [];
  const device: DeepLinkConfirmationDevice = {
    waitForDestination: async (step) => {
      log.push(step);
      const next = destinationWaits.shift();
      assert.ok(next, `unexpected destination wait: ${step}`);
      return next;
    },
    inspectAlert: async () => {
      log.push('alert get');
      const next = alerts.shift();
      assert.ok(next, 'unexpected alert probe');
      return next;
    },
    acceptAlert: async () => {
      log.push('alert accept');
    },
  };
  return { device, log };
}

const waits = (log: string[]) => log.filter((step) => step.startsWith('wait for')).length;

test('a destination that arrives never probes for the confirmation', async () => {
  const { device, log } = simulator([LANDED]);

  await answerDeepLinkConfirmation(device);

  assert.deepEqual(log, ['wait for the deep-link destination (1/5)']);
});

test('a readable destination timeout still answers a real Open confirmation', async () => {
  const { device, log } = simulator([READABLE_TIMEOUT, LANDED]);

  await answerDeepLinkConfirmation(device);

  assert.deepEqual(log, [
    'wait for the deep-link destination (1/5)',
    'alert get',
    'alert accept',
    'wait for the deep-link destination (2/5)',
  ]);
});

test('a readable no-match that answers Open waits for the released launch', async () => {
  const { device, log } = simulator([WRONG_ROUTE, LAUNCH_PENDING, LANDED]);

  await answerDeepLinkConfirmation(device);

  assert.deepEqual(log, [
    'wait for the deep-link destination (1/5)',
    'alert get',
    'alert accept',
    'wait for the deep-link destination (2/5)',
    'wait for the deep-link destination (3/5)',
  ]);
});

test('a truncated capture retries for four bounded waits without accepting a missing alert', async () => {
  const { device, log } = simulator(
    [READABLE_TIMEOUT, READABLE_TIMEOUT, READABLE_TIMEOUT, READABLE_TIMEOUT, LANDED],
    [NO_ALERT, NO_ALERT, NO_ALERT, NO_ALERT],
  );

  await answerDeepLinkConfirmation(device);

  assert.equal(waits(log), 5);
  assert.equal(log.filter((step) => step === 'alert get').length, 4);
  assert.equal(log.includes('alert accept'), false);
});

test('the launch an accepted confirmation releases is waited for until it lands', async () => {
  // CI run 35991523779: the app reached the foreground 20.7 s after `alert accept` tapped Open.
  const { device, log } = simulator([LAUNCH_PENDING, LAUNCH_PENDING, LAUNCH_PENDING, LANDED]);

  await answerDeepLinkConfirmation(device);

  assert.deepEqual(log, [
    'wait for the deep-link destination (1/5)',
    'alert get',
    'alert accept',
    'wait for the deep-link destination (2/5)',
    'wait for the deep-link destination (3/5)',
    'wait for the deep-link destination (4/5)',
  ]);
});

test('a readable miss probes once and leaves a wrong route to the caller', async () => {
  const { device, log } = simulator([WRONG_ROUTE], [NO_ALERT]);

  await answerDeepLinkConfirmation(device);

  assert.deepEqual(log, ['wait for the deep-link destination (1/5)', 'alert get']);
});

test('after the accept, a readable no-match still gets a bounded launch wait', async () => {
  const { device, log } = simulator([LAUNCH_PENDING, WRONG_ROUTE, LANDED]);

  await answerDeepLinkConfirmation(device);

  assert.equal(waits(log), 3);
});

test('a confirmation that appears late is still answered once', async () => {
  const { device, log } = simulator(
    [LAUNCH_PENDING, LAUNCH_PENDING, LAUNCH_PENDING, LANDED],
    [NO_ALERT, OPEN_PROMPT],
  );

  await answerDeepLinkConfirmation(device);

  assert.deepEqual(
    log.filter((step) => step.startsWith('alert')),
    ['alert get', 'alert get', 'alert accept'],
  );
});

test('the wait budget is bounded when the app never starts', async () => {
  const { device, log } = simulator(Array.from({ length: 5 }, () => LAUNCH_PENDING));

  await answerDeepLinkConfirmation(device);

  assert.equal(waits(log), 5);
});

test('a prompt that is not the deep-link confirmation is never accepted', async () => {
  const { device, log } = simulator(
    [LAUNCH_PENDING],
    [result(0, { data: { message: 'Allow notifications?', items: ['Allow'] } })],
  );

  await assert.rejects(answerDeepLinkConfirmation(device));
  assert.equal(log.includes('alert accept'), false);
});
