import { expect, test } from 'vitest';
import {
  type AndroidScreenRecordingProcessOwnership,
  provesAndroidScreenRecordPathUnclaimed,
  provesAndroidScreenRecordTermination,
} from './screen-recording-runtime-host.ts';

type Proof = readonly [
  ownership: AndroidScreenRecordingProcessOwnership,
  termination: boolean,
  pathUnclaimed: boolean,
];

const PROOFS: readonly Proof[] = [
  ['missing', true, true],
  ['ownership-lost', true, true],
  ['foreign-writer', true, false],
  ['owned-alive', false, false],
  ['uncertain', false, false],
];

test.each(PROOFS)(
  'observation %s proves termination as %s and an unclaimed path as %s',
  (ownership, termination, pathUnclaimed) => {
    expect(provesAndroidScreenRecordTermination(ownership)).toBe(termination);
    expect(provesAndroidScreenRecordPathUnclaimed(ownership)).toBe(pathUnclaimed);
  },
);
