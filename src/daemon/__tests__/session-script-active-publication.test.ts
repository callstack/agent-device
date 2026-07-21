import { describe, expect, test } from 'vitest';
import type { TargetAnnotationV1 } from '../../replay/target-identity.ts';
import type { SessionAction } from '../types.ts';
import {
  assertActivePublicationPortability,
  validateActivePublicationActions,
} from '../session-script-active-publication.ts';

const TARGET_EVIDENCE: TargetAnnotationV1 = {
  id: 'continue',
  role: 'button',
  label: 'Continue',
  ancestry: [],
  sibling: 0,
  viewportOrder: 0,
  verification: 'verified',
};

function action(command: string, positionals: string[] = []): SessionAction {
  return { ts: 1, command, positionals, flags: {} };
}

describe('ADR 0016 active publication contract', () => {
  test('accepts exactly one initial open and a selector guard after the final mutation', () => {
    const actions = [
      action('open', ['Demo']),
      { ...action('press', ['id="continue"']), targetEvidence: TARGET_EVIDENCE },
      action('wait', ['role="heading" label="Screen X"']),
      action('wait', ['stable']),
    ];

    expect(() => validateActivePublicationActions(actions)).not.toThrow();
    expect(() => assertActivePublicationPortability(actions)).not.toThrow();
  });

  test.each([
    ['duration', ['100']],
    ['stable', ['stable']],
    ['ref', ['@e7']],
    ['text', ['text', 'Screen X']],
  ])('rejects %s wait as the destination guard', (_kind, waitPositionals) => {
    expect(() =>
      validateActivePublicationActions([action('open', ['Demo']), action('wait', waitPositionals)]),
    ).toThrow(/portable destination guard/);
  });

  test('requires the guard after request-sensitive mutations', () => {
    expect(() =>
      validateActivePublicationActions([
        action('open', ['Demo']),
        action('wait', ['id="screen-x"']),
        action('alert', ['accept']),
      ]),
    ).toThrow(/after the final mutating action/);

    expect(() =>
      validateActivePublicationActions([
        action('open', ['Demo']),
        action('keyboard', ['status']),
        action('wait', ['id="screen-x"']),
      ]),
    ).not.toThrow();
  });

  test('rejects multiple opens, close, bare refs, and missing target-v1 evidence', () => {
    expect(() =>
      validateActivePublicationActions([
        action('open', ['Demo']),
        action('open', ['Other']),
        action('wait', ['id="screen-x"']),
      ]),
    ).toThrow(/exactly one initial recorded open/);
    expect(() =>
      validateActivePublicationActions([
        action('open', ['Demo']),
        action('close'),
        action('wait', ['id="screen-x"']),
      ]),
    ).toThrow(/containing close/);
    expect(() => assertActivePublicationPortability([action('wait', ['@e7'])])).toThrow(
      /session-local ref/,
    );
    expect(() => assertActivePublicationPortability([action('press', ['id="continue"'])])).toThrow(
      /target identity evidence is missing/,
    );
  });

  test('treats leading-at user text as data rather than a session ref', () => {
    expect(() =>
      assertActivePublicationPortability([
        action('type', ['@thymikee']),
        {
          ...action('fill', ['id="handle"', '@someone']),
          targetEvidence: TARGET_EVIDENCE,
        },
        action('find', ['text', '@handle', 'get', 'text']),
      ]),
    ).not.toThrow();
  });

  test('refuses mutating find actions until they record target identity evidence', () => {
    expect(() =>
      assertActivePublicationPortability([action('find', ['text', 'Continue', 'click'])]),
    ).toThrow(/mutating find.*target identity is not replay-verifiable/);
  });
});
