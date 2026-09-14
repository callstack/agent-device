import { describe, expect, test } from 'vitest';
import { RECORDER_OBSERVATION_VALUES, isStopObservation } from './recording-stop-observation.ts';

describe('recording stop observation', () => {
  test('names the three words a backend can report', () => {
    expect(RECORDER_OBSERVATION_VALUES).toEqual(['confirmed', 'unconfirmed', 'lost']);
  });

  test('accepts a confirmed recorder with no reason and a refused one with its own reason', () => {
    expect(isStopObservation({ recorder: 'confirmed' })).toBe(true);
    expect(isStopObservation({ recorder: 'unconfirmed', why: 'identity-unreadable' })).toBe(true);
    expect(isStopObservation({ recorder: 'unconfirmed', why: 'no-exit-in-budget' })).toBe(true);
    expect(isStopObservation({ recorder: 'lost', why: 'identity-not-ours' })).toBe(true);
    expect(isStopObservation({ recorder: 'lost', why: 'owner-session-lost' })).toBe(true);
    expect(isStopObservation({ recorder: 'lost', why: 'native-artifact-absent' })).toBe(true);
  });

  test('rejects a word or a reason a backend could never have reported', () => {
    expect(isStopObservation({ recorder: 'confirmed', why: 'no-exit-in-budget' })).toBe(false);
    expect(isStopObservation({ recorder: 'unconfirmed' })).toBe(false);
    expect(isStopObservation({ recorder: 'lost', why: 'identity-unreadable' })).toBe(false);
    expect(isStopObservation({ recorder: 'unconfirmed', why: 'identity-not-ours' })).toBe(false);
    expect(isStopObservation({ recorder: 'gone' })).toBe(false);
    expect(isStopObservation('confirmed')).toBe(false);
    expect(isStopObservation(undefined)).toBe(false);
  });
});
