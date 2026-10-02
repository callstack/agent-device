import { test, expect } from 'vitest';
import { buildReplayDivergenceFailureResponseFromDescriptor } from '../session-replay-runtime-failure-response.ts';

test('native replay failure metadata keeps machine fields and daemon-owned paths intact', () => {
  const replayPath = '/tmp/flows/ios-login.ad';
  const artifactPath = '/tmp/sessions/default/screenshot-1.png';
  const response = buildReplayDivergenceFailureResponseFromDescriptor({
    error: {
      code: 'COMMAND_FAILED',
      message: 'Could not tap Continue on ios',
      hint: 'Retry Continue on ios',
      details: {
        reason: 'not_found',
        retriable: false,
        supportedOn: 'ios',
      },
      retriable: false,
      supportedOn: 'ios',
    },
    actionLabel: 'press Continue',
    action: 'press',
    positionals: ['Continue'],
    step: 2,
    replayPath,
    artifactPaths: [artifactPath],
    divergence: {},
    scrubVars: [
      { name: 'MODE', value: 'on' },
      { name: 'PLATFORM', value: 'ios' },
      { name: 'SESSION', value: 'default' },
    ],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.retriable).toBe(false);
  expect(response.error.supportedOn).toBe('ios');
  expect(response.error.details).toMatchObject({
    reason: 'not_found',
    retriable: false,
    supportedOn: 'ios',
    replayPath,
    positionals: ['Continue'],
    artifactPaths: [artifactPath],
  });
  expect(response.error.details).toHaveProperty('reason');
  expect(response.error.details).not.toHaveProperty('reas<var:MODE>');
});

test('a replay divergence carries the readiness evidence of an exhausted target wait', () => {
  const readiness = { polls: 11, waitedMs: 2_004, end: 'expired' };
  const response = buildReplayDivergenceFailureResponseFromDescriptor({
    error: {
      code: 'COMMAND_FAILED',
      message: 'Selector did not match',
      details: { reason: 'selector_not_found', readiness },
    },
    actionLabel: 'press label=Continue',
    action: 'press',
    positionals: ['label=Continue'],
    step: 3,
    replayPath: '/tmp/flows/checkout.ad',
    artifactPaths: [],
    divergence: {},
    scrubVars: [],
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  expect(response.error.details).toMatchObject({ reason: 'selector_not_found', readiness });
});
