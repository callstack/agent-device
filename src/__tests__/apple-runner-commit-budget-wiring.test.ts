import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const synthesizedTextEntryPath = path.join(
  repoRoot,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+SynthesizedTextEntry.swift',
);

// #1874: the synthesized commit wait grants time against progress instead of a flat deadline, and
// that only works if the two halves stay connected — `observe` must record each poll's
// expected-prefix length into the budget, and `isExpired` must ask that same budget. Delete either
// side and every Swift test still passes: `SynthesizedCommitBudgetTests` drives the budget
// directly, and the one test that runs the real wait observes `nil` on every poll, so it never
// records progress and expires at the stall budget either way. The wait would silently revert to
// the flat 3s deadline the issue is about, with nothing red.
//
// A structural guard rather than an executed one because the coupling lives inside two escaping
// closures built for a live XCUIElement; there is no seam that can be driven from a host lane
// without a simulator and a field whose value grows over several seconds.

function extractIngredients(source: string): string {
  const start = source.indexOf('private func synthesizedCommitPollingIngredients');
  assert.ok(start !== -1, 'the commit wait must keep its polling-ingredients seam');
  const end = source.indexOf('\n  /// Blocks until', start);
  assert.ok(end !== -1, 'the ingredients function must precede the commit waits that consume it');
  return source.slice(start, end);
}

test('the commit wait records progress into the same budget its deadline reads', () => {
  const ingredients = extractIngredients(fs.readFileSync(synthesizedTextEntryPath, 'utf8'));

  assert.match(
    ingredients,
    /isExpired: \{ budget\.isExpired\(at: Date\(\)\) \}/,
    'the deadline must be the budget, not a flat wall-clock deadline',
  );

  const observeStart = ingredients.indexOf('observe: {');
  const observeEnd = ingredients.indexOf('waitForNextObservation:', observeStart);
  assert.ok(observeStart !== -1 && observeEnd !== -1, 'the wait must keep its observe seam');
  assert.match(
    ingredients.slice(observeStart, observeEnd),
    /budget\.record\(expectedPrefixLength:/,
    'every observation must record its expected-prefix length, or the budget never extends',
  );

  assert.match(
    ingredients,
    /stallBudget: TextEntryTiming\.synthesizedCommitStallTimeout/,
    'the no-progress budget must stay the flat deadline it replaced',
  );
  assert.match(
    ingredients,
    /ceiling: TextEntryTiming\.synthesizedCommitCeiling/,
    'progress must stay bounded by an absolute ceiling',
  );
});
