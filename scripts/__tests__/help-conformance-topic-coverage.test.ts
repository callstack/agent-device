import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CASES } from '../help-conformance-cases.mjs';
import { helpTopicIds } from '../../src/cli/parser/cli-help.ts';

// "What enumerates N": benchmark cases are keyed to help topics, and this gate
// keys the case list to the topic registry itself. A new help topic must gain
// a benchmark case (docs: [..., '<topic>']) or an explicit waiver here — the
// waiver names why the topic's guidance is not yet benchmarked, so uncovered
// topics are a visible decision instead of silent drift.
const WAIVED_TOPICS: Record<string, string> = {
  cdp: 'JS-heap forensics niche; add cases when heap-guidance regressions show up in practice.',
  macos: 'macOS surface guidance is thin and stable; no observed planning regressions yet.',
  maestro: 'Compatibility reference, not a planning loop; conformance is oracle-tested instead.',
  'physical-device': 'Needs device-specific setup guidance; no portable planning task defined yet.',
  'react-devtools':
    'Profiling-window guidance; add cases when render-diagnosis planning regresses.',
  remote: 'Remote/cloud lease setup; niche until remote workflows are benchmarked end to end.',
};

const FIRST_SCREEN_DOC = '--help:first30';

test('every case doc id is the first screen or a real help topic', () => {
  const topics = new Set(helpTopicIds());
  for (const testCase of CASES) {
    for (const doc of testCase.docs) {
      assert.ok(
        doc === FIRST_SCREEN_DOC || topics.has(doc),
        `case "${testCase.id}" references unknown help doc "${doc}"`,
      );
    }
  }
});

test('every help topic has a benchmark case or an explicit waiver', () => {
  const covered = new Set(CASES.flatMap((testCase) => testCase.docs));
  const uncovered = helpTopicIds().filter(
    (topic) => !covered.has(topic) && !(topic in WAIVED_TOPICS),
  );
  assert.deepEqual(
    uncovered,
    [],
    'new help topics need a benchmark case in scripts/help-conformance-cases.mjs or a waiver above',
  );
});

test('waivers only name real, uncovered topics', () => {
  const topics = new Set(helpTopicIds());
  const covered = new Set(CASES.flatMap((testCase) => testCase.docs));
  for (const [topic, reason] of Object.entries(WAIVED_TOPICS)) {
    assert.ok(topics.has(topic), `waived topic "${topic}" no longer exists — remove the waiver`);
    assert.ok(
      !covered.has(topic),
      `waived topic "${topic}" is now covered by a case — remove the waiver`,
    );
    assert.ok(reason.trim().length > 0, `waiver for "${topic}" needs a reason`);
  }
});

test('the first help screen is exercised by every case family', () => {
  for (const testCase of CASES) {
    assert.ok(
      testCase.docs.includes(FIRST_SCREEN_DOC),
      `case "${testCase.id}" must include the first-screen doc — it is the only text every runner sees before choosing a topic`,
    );
  }
});
