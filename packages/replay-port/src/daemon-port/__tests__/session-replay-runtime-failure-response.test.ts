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
