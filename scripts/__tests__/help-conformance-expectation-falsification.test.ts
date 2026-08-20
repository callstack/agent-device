import assert from 'node:assert/strict';
import { test } from 'vitest';
import { KNOWN_EXPECTATIONS, scoreExpectations } from '../help-conformance-case-checks.mjs';
import { validatePlanCommands } from '../help-conformance-plan-validator.mjs';
import {
  EXPECTATION_FIXTURES,
  type ExpectationWitness,
} from './help-conformance-expectation-fixtures.ts';

// "What enumerates N" for the expectation surface (see the analogous gates
// for help topics and error-recovery quizzes): KNOWN_EXPECTATIONS is the
// scorer registry itself (help-conformance-case-checks.mjs
// EXPECTATION_SCORERS), so a new named expectation with no falsification
// fixture fails this gate instead of silently shipping unfalsifiable. An
// oracle nobody has proven can fail is not an oracle — it is decoration that
// reports every plan as passing whether or not its regex or predicate still
// matches anything.

test('every named expectation has a falsification fixture', () => {
  const missing = KNOWN_EXPECTATIONS.filter((id) => !(id in EXPECTATION_FIXTURES));
  assert.deepEqual(
    missing,
    [],
    `add a scripts/__tests__/help-conformance-expectation-fixtures.ts entry for: ${missing.join(', ')}`,
  );
});

test('the fixture registry names only real, current expectations', () => {
  const known = new Set<string>(KNOWN_EXPECTATIONS);
  const stale = Object.keys(EXPECTATION_FIXTURES).filter((id) => !known.has(id));
  assert.deepEqual(
    stale,
    [],
    `fixture(s) for a retired/renamed expectation: ${stale.join(', ')} — remove them`,
  );
});

test('every fixture set declares a passing witness and at least one counterexample', () => {
  for (const [id, fixture] of Object.entries(EXPECTATION_FIXTURES)) {
    assert.ok(fixture.passing, `expectation "${id}" needs a passing witness`);
    assert.ok(
      fixture.counterexamples.length > 0,
      `expectation "${id}" needs at least one known-bad counterexample`,
    );
    for (const counter of fixture.counterexamples) {
      assert.ok(
        counter.id.trim().length > 0,
        `expectation "${id}" has a counterexample with no id`,
      );
    }
  }
});

/** Runs a witness through the real production scorer pipeline, not a reimplementation. */
async function score(id: string, witness: ExpectationWitness): Promise<boolean> {
  const commandValidation = await validatePlanCommands(witness.commands, {
    allowedExternalCommands: witness.allowedExternalCommands,
  });
  const raw = witness.commands.join('\n');
  const checks = scoreExpectations(
    { expectations: [id] },
    witness.commands,
    raw,
    commandValidation,
  );
  return checks[id] === true;
}

// One vitest test per witness/counterexample (rather than one loop inside a
// single test) so a failure names the exact fixture that broke, and so the
// many real validatePlanCommands subprocess calls this drives don't compound
// into one test's timeout budget.
for (const [id, fixture] of Object.entries(EXPECTATION_FIXTURES)) {
  test(`${id}: passing witness scores true`, async () => {
    assert.equal(
      await score(id, fixture.passing),
      true,
      `expectation "${id}" passing witness must score true: ${JSON.stringify(fixture.passing.commands)}`,
    );
  });

  for (const counter of fixture.counterexamples) {
    test(`${id}: counterexample "${counter.id}" scores false`, async () => {
      assert.equal(
        await score(id, counter),
        false,
        `expectation "${id}" counterexample "${counter.id}" must score false: ${JSON.stringify(counter.commands)}`,
      );
    });
  }

  if (fixture.metamorphic) {
    const metamorphic = fixture.metamorphic;
    test(`${id}: metamorphic variant differs from the witness and still scores true`, async () => {
      assert.notDeepEqual(
        metamorphic.commands,
        fixture.passing.commands,
        `expectation "${id}" metamorphic variant must actually differ from the passing witness`,
      );
      assert.equal(
        await score(id, metamorphic),
        true,
        `expectation "${id}" metamorphic variant must still score true: ${JSON.stringify(metamorphic.commands)}`,
      );
    });
  }
}
