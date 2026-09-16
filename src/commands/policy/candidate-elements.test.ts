import { describe, expect, test } from 'vitest';
import {
  findKeypadDigit,
  screenDigest,
  screenLabel,
  selectableCandidates,
  toPolicyCandidates,
  type PolicySnapshotNode,
} from './candidate-elements.ts';

const signInScreen: PolicySnapshotNode[] = [
  { index: 0, type: 'Application', label: 'shelf', ref: 'e1' },
  { index: 1, parentIndex: 0, type: 'StaticText', label: 'Sign in with your phone.', ref: 'e2' },
  { index: 2, parentIndex: 0, type: 'CollectionView', ref: 'e3' },
  { index: 3, parentIndex: 2, type: 'Cell', label: 'US +1', ref: 'e4' },
  {
    index: 4,
    parentIndex: 3,
    type: 'TextField',
    label: 'Phone number',
    identifier: 'phoneField',
    value: '',
    ref: 'e5',
  },
  { index: 5, parentIndex: 0, type: 'Button', label: 'Send code', enabled: false, ref: 'e6' },
];

describe('policy candidate projection', () => {
  test('projects a snapshot into candidates a policy can choose between', () => {
    expect(toPolicyCandidates(signInScreen)).toEqual([
      { ref: '@e2', role: 'text', name: 'Sign in with your phone.' },
      {
        ref: '@e5',
        role: 'textfield',
        name: 'Phone number',
        identifier: 'phoneField',
        value: '',
      },
      { ref: '@e6', role: 'button', name: 'Send code', disabled: true },
    ]);
  });

  test('drops a cell that only wraps an actionable leaf', () => {
    const refs = toPolicyCandidates(signInScreen).map((candidate) => candidate.ref);
    expect(refs).not.toContain('@e4');
  });

  test('offers only enabled, non-text candidates as choices', () => {
    expect(selectableCandidates(toPolicyCandidates(signInScreen))).toEqual([
      {
        ref: '@e5',
        role: 'textfield',
        name: 'Phone number',
        identifier: 'phoneField',
        value: '',
      },
    ]);
  });

  test('digests the screen by content, so a reissued ref is not a change', () => {
    const reissued = signInScreen.map((node) => ({ ...node, ref: `${node.ref}0` }));
    expect(screenDigest(toPolicyCandidates(reissued))).toBe(
      screenDigest(toPolicyCandidates(signInScreen)),
    );
  });

  test('digests a changed field value as a change', () => {
    const filled = signInScreen.map((node) =>
      node.identifier === 'phoneField' ? { ...node, value: '(555) 555-0100' } : node,
    );
    expect(screenDigest(toPolicyCandidates(filled))).not.toBe(
      screenDigest(toPolicyCandidates(signInScreen)),
    );
  });

  test('labels a screen from its leading text and first controls', () => {
    expect(screenLabel(toPolicyCandidates(signInScreen))).toBe(
      'Sign in with your phone. | Phone number',
    );
  });

  test('finds the keypad key that enters a digit', () => {
    const keypad: PolicySnapshotNode[] = [
      { index: 0, type: 'Key', label: '4', ref: 'e30' },
      { index: 1, type: 'Key', label: '7', ref: 'e31' },
    ];
    expect(findKeypadDigit(keypad, '7')?.ref).toBe('e31');
    expect(findKeypadDigit(keypad, '9')).toBeUndefined();
  });
});
