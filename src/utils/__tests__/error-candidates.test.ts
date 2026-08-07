import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatErrorCandidateLines } from '../error-candidates.ts';

// #1597: the element-match block. `candidates` are already-rendered snapshot
// lines capped by buildAmbiguousMatchError; `matches` is the true total the
// "+N more" marker is computed from.
test('formatErrorCandidateLines renders element matches with the true total', () => {
  assert.deepEqual(
    formatErrorCandidateLines({
      locator: 'text',
      query: 'Follow',
      matches: 3,
      candidates: ['@e2 [button] "Follow"', '@e5 [button] "Follow"', '@e9 [button] "Follow"'],
    }),
    [
      'Candidates:',
      '  @e2 [button] "Follow"',
      '  @e5 [button] "Follow"',
      '  @e9 [button] "Follow"',
    ],
  );
});

test('formatErrorCandidateLines marks how many matches the cap omitted', () => {
  const lines = formatErrorCandidateLines({
    matches: 7,
    candidates: [
      '@e2 [button] "Row"',
      '@e3 [button] "Row"',
      '@e4 [button] "Row"',
      '@e5 [button] "Row"',
      '@e6 [button] "Row"',
    ],
  });

  assert.equal(lines.at(-1), '  +2 more');
});

test('formatErrorCandidateLines pins partial-frame candidates for direct CLI reuse', () => {
  assert.deepEqual(
    formatErrorCandidateLines({
      matches: 2,
      candidates: ['@e2 [button] "Team Standup"', '@e5 [cell] "Team Standup"'],
      refsGeneration: 42,
    }),
    ['Candidates:', '  @e2~s42 [button] "Team Standup"', '  @e5~s42 [cell] "Team Standup"'],
  );
});

test('formatErrorCandidateLines returns nothing when details carry no candidate list', () => {
  assert.deepEqual(formatErrorCandidateLines(undefined), []);
  assert.deepEqual(formatErrorCandidateLines({ matches: 3 }), []);
  assert.deepEqual(formatErrorCandidateLines({ candidates: [] }), []);
  assert.deepEqual(formatErrorCandidateLines({ devices: [] }), []);
});

// The device domain owns `devices`, so the two shapes no longer collide on one
// key and the device list renders instead of being suppressed as unrenderable.
test('formatErrorCandidateLines renders device candidates udid-first', () => {
  assert.deepEqual(
    formatErrorCandidateLines({
      appTarget: 'com.example.app',
      devices: [
        { id: 'SIM-001', name: 'iPhone 17 Pro' },
        { id: 'SIM-002', name: 'iPhone 17' },
      ],
    }),
    ['Devices:', '  SIM-001  iPhone 17 Pro', '  SIM-002  iPhone 17'],
  );
});

// `details` crosses the daemon RPC wire as JSON, so a daemon predating the
// `devices` key still sends device objects under `candidates`. That must render
// nothing — never "Candidates:\n  [object Object]".
test('formatErrorCandidateLines ignores device objects sent under the element-match key', () => {
  assert.deepEqual(
    formatErrorCandidateLines({
      appTarget: 'com.example.app',
      candidates: [
        { id: 'SIM-001', name: 'iPhone 17 Pro' },
        { id: 'SIM-002', name: 'iPhone 17' },
      ],
    }),
    [],
  );
});
