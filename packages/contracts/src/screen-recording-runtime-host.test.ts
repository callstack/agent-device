import { expect, test } from 'vitest';
import {
  type AndroidScreenRecordingProcessOwnership,
  provesAndroidScreenRecordTermination,
} from './screen-recording-runtime-host.ts';

const TERMINATION_PROOF: readonly (readonly [AndroidScreenRecordingProcessOwnership, boolean])[] = [
  ['missing', true],
  ['ownership-lost', true],
  ['owned-alive', false],
  ['uncertain', false],
];

test.each(TERMINATION_PROOF)(
  'observation %s proves recorder termination as %s',
  (ownership, expected) => {
    expect(provesAndroidScreenRecordTermination(ownership)).toBe(expected);
  },
);
