import { expect, test } from 'vitest';
import type {
  LaunchConfirmationOutcome,
  LaunchConfirmationProbeFailure,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { LaunchConfirmationAttempt } from './launch-confirmation.ts';
import { applyAttemptReport } from './open-policy.ts';

type Report = Readonly<{
  report?: LaunchConfirmationOutcome;
  probeFailure?: LaunchConfirmationProbeFailure;
}>;

/**
 * The mapping's cases at both ends: every attempt kind against a fresh settle, and attempts that
 * follow a settle already holding a report or an unknown state. `applyAttemptReport` owns the
 * rule and its url-owner exception; each expected row here restates only its own case.
 */
const freshCases: ReadonlyArray<Readonly<[string, LaunchConfirmationAttempt, Report]>> = [
  ['accepted', { outcome: 'accepted' }, { report: { launchConfirmation: 'accepted' } }],
  ['absent', { outcome: 'absent' }, {}],
  [
    'an unrecognized prompt',
    { outcome: 'unanswered', reason: 'alert-unrecognized' },
    {
      report: {
        launchConfirmation: 'unanswered',
        launchConfirmationReason: 'alert-unrecognized',
      },
    },
  ],
  [
    'an unresolved URL owner',
    { outcome: 'unanswered', reason: 'url-owner-unresolved' },
    {
      report: {
        launchConfirmation: 'unanswered',
        launchConfirmationReason: 'url-owner-unresolved',
      },
    },
  ],
  [
    'a persistent prompt after a failed accept',
    { outcome: 'unanswered', reason: 'alert-still-present' },
    // The failed-accept path fails the open outright; nothing to report alongside a throw.
    {},
  ],
  [
    'a failed alert read',
    { outcome: 'unreadable', step: 'alert-read' },
    { probeFailure: 'alert-read' },
  ],
  [
    'a failed accept',
    { outcome: 'unreadable', step: 'alert-accept' },
    { probeFailure: 'alert-accept' },
  ],
  ['an unresolvable runner', { outcome: 'unreadable', step: 'runner' }, { probeFailure: 'runner' }],
  [
    'a failed URL-owner lookup',
    { outcome: 'unreadable', step: 'url-owner' },
    {
      report: {
        launchConfirmation: 'unanswered',
        launchConfirmationReason: 'url-owner-unresolved',
      },
    },
  ],
];

test.each(freshCases)(
  'a fresh settle where the attempt %s reports %j',
  (_name, attempt, expected) => {
    expect(applyAttemptReport({}, attempt)).toEqual(expected);
  },
);

const heldCases: ReadonlyArray<Readonly<[string, Report, LaunchConfirmationAttempt, Report]>> = [
  [
    'an accepted confirmation',
    { report: { launchConfirmation: 'accepted' } },
    { outcome: 'unreadable', step: 'alert-read' },
    // The latest probe state wins: the accepted must not hide an unknown final state.
    { probeFailure: 'alert-read' },
  ],
  [
    'an accepted confirmation',
    { report: { launchConfirmation: 'accepted' } },
    { outcome: 'absent' },
    { report: { launchConfirmation: 'accepted' } },
  ],
  [
    'a probe failure',
    { probeFailure: 'alert-read' },
    { outcome: 'absent' },
    // A completed probe that finds nothing resolves the unknown state.
    {},
  ],
  [
    'a probe failure',
    { probeFailure: 'alert-read' },
    { outcome: 'unreadable', step: 'runner' },
    { probeFailure: 'runner' },
  ],
];

test.each(heldCases)(
  'a settle holding %s where the next attempt is %j reports %j',
  (_held, previous, attempt, expected) => {
    expect(applyAttemptReport(previous, attempt)).toEqual(expected);
  },
);
