import assert from 'node:assert/strict';
import { test } from 'vitest';
import { RECORDING_FACTS_KEYS, recordingFactsAreValid } from './recording-facts.ts';

const FACTS = Object.freeze({
  scope: 'device',
  showTouches: true,
  recordOnlySession: false,
});

function facet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FACTS, ...overrides };
}

test('accepts the facts a caller asked for, with or without the optional ones', () => {
  assert.equal(recordingFactsAreValid(facet()), true);
  assert.equal(
    recordingFactsAreValid(
      facet({ activeSessionApp: { bundleId: 'com.example.app', name: 'Example' } }),
    ),
    true,
  );
  assert.equal(recordingFactsAreValid(facet({ exportQuality: 'high' })), true);
});

test('refuses a facet whose recording facts no start could have produced', () => {
  assert.equal(recordingFactsAreValid(facet({ scope: 'window' })), false);
  assert.equal(recordingFactsAreValid(facet({ showTouches: 'yes' })), false);
  assert.equal(recordingFactsAreValid(facet({ recordOnlySession: 1 })), false);
  assert.equal(recordingFactsAreValid({ ...FACTS, showTouches: undefined }), false);
});

test('refuses an optional fact that is present but unreadable rather than dropping it', () => {
  assert.equal(recordingFactsAreValid(facet({ exportQuality: 'ultra' })), false);
  assert.equal(recordingFactsAreValid(facet({ activeSessionApp: { bundleId: '' } })), false);
  assert.equal(recordingFactsAreValid(facet({ activeSessionApp: { name: 'Example' } })), false);
  assert.equal(recordingFactsAreValid(facet({ activeSessionApp: 'com.example.app' })), false);
  assert.equal(
    recordingFactsAreValid(facet({ activeSessionApp: { bundleId: 'a', name: '' } })),
    false,
  );
});

test('names every key of the facet it validates', () => {
  const declared = Object.keys({ ...FACTS, activeSessionApp: undefined, exportQuality: undefined });
  assert.deepEqual([...RECORDING_FACTS_KEYS].sort(), declared.sort());
});
