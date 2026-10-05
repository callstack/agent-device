import { test, expect } from 'vitest';
import { ANDROID_SHELL_TEXT_UNSUPPORTED_REASON } from '@agent-device/contracts/input-validation';
import {
  ANDROID_TEST_IME_FLOW_HINT,
  buildReplayDivergenceFailureResponseFromDescriptor,
  hoistReplayFailureCauseDiagnosticMeta,
} from '../session-replay-runtime-failure-response.ts';

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

// #2997: the Android platform states `open --test-ime` because it sees one dispatched
// session-open. On this surface that advice is unactionable — a flow caller never runs
// `open` — so the cause's hint is replaced off the typed reason, never off the message.
// The fixture carries the production shape: the cause arrives WITH the open-route hint
// already hoisted, so a rewrite that only fills a missing hint would still fail here.
test('an Android shell-text cause gets the flow-owned --test-ime recovery', () => {
  // The platform's own hint travels over the wire, so the fixture states it literally the way
  // a consumer sees it: replay-port never imports the Android package.
  const openRouteHint =
    'On emulators the test IME activates automatically; on real devices pass `open --test-ime` to enable it (see `agent-device doctor` for the current IME state).';
  const cause = hoistReplayFailureCauseDiagnosticMeta({
    code: 'COMMAND_FAILED',
    message:
      'Android text input requires provider-native text injection or the bundled test IME helper for non-ASCII/control characters; the adb-shell fallback supports ASCII text only.',
    hint: openRouteHint,
    details: { reason: ANDROID_SHELL_TEXT_UNSUPPORTED_REASON, hint: openRouteHint },
  });

  expect(cause.hint).toBe(ANDROID_TEST_IME_FLOW_HINT);
  expect(cause.hint).toContain('--test-ime');
  expect(cause.hint).not.toContain('open --test-ime');
});

test('a cause without the Android shell-text reason keeps its own hoisted hint', () => {
  const cause = hoistReplayFailureCauseDiagnosticMeta({
    code: 'COMMAND_FAILED',
    message: 'Selector did not match',
    details: { reason: 'selector_not_found', hint: 'Inspect the latest snapshot.' },
  });

  expect(cause.hint).toBe('Inspect the latest snapshot.');
});
