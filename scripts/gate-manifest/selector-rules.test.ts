// Deriving the affected-selector's category universe from its source.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readSelectorRules } from './selector-rules.ts';
import { FORWARDED_SELECTOR_RULES } from './waivers.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const SELECTOR_SOURCE = 'scripts/check-affected/model.ts';

const TABLE = `const BUILD_OWNERSHIP = [
  { check: 'swift-runner', rule: 'own:swift', detail: 'd', owns: () => true },
];`;

test('literal rules are collected from both reason() calls and the ownership table', () => {
  const source = `
    function reason(check, file, rule, detail) { return { check, path: file, rule, detail }; }
    ${TABLE}
    const a = reason('lint', file, 'gate:lint', 'oxlint covers the source tree');
  `;
  assert.deepEqual(readSelectorRules('m.ts', source).rules, ['gate:lint', 'own:swift']);
});

test('a fail-open literal is not a category, because it pairs rule: with path:', () => {
  const source = `
    const a = reason('lint', file, 'gate:lint', 'd');
    const open = { path: file, rule: 'workflow-tooling', detail: 'anything can change' };
  `;
  assert.deepEqual(readSelectorRules('m.ts', source).rules, ['gate:lint']);
});

test("the reason factory's own return object declares no category", () => {
  // `return { check, path: file, rule, detail }` pairs check with rule and would otherwise read
  // as a build-ownership entry whose rule is not a literal. It is excluded by the factory's
  // source span, not by "any shorthand rule" — which would also swallow a real table entry.
  const source = `
    function reason(check, file, rule, detail) { return { check, path: file, rule, detail }; }
    const a = reason('lint', file, 'gate:lint', 'd');
  `;
  assert.deepEqual(readSelectorRules('m.ts', source).rules, ['gate:lint']);
});

// --- Nothing but a literal is derived ---------------------------------------

/**
 * Every shape that seven rounds of review argued about.
 *
 * Earlier revisions tried to decide these case by case — is this `entry` really the ownership
 * table's? — and each answer left the next construct open. They are one test now because the
 * reader gives them one answer: a rule that is not a literal fails closed. The list stays as the
 * regression record, so a future attempt to re-introduce shape detection has to face all of it
 * at once rather than one clever case at a time.
 */
const NOT_A_LITERAL: readonly { name: string; source: string }[] = [
  { name: 'an unrelated object', source: "const a = reason('lint', file, config.rule, 'd');" },
  { name: 'a free binding', source: "const a = reason('lint', file, entry.rule, 'd');" },
  {
    name: 'an array that is not the ownership table',
    source: `const OTHER = [{ id: 'x', rule: 'not-a-category' }];
      const a = OTHER.map((entry) => reason('lint', file, entry.rule, 'd'));`,
  },
  {
    name: "the selector's own live filter/map chain",
    source: `${TABLE}
      const s = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) =>
        reason(entry.check, file, entry.rule, entry.detail),
      );`,
  },
  {
    name: 'a same-named binding beside the real loop',
    source: `${TABLE}
      const good = BUILD_OWNERSHIP.map((entry) => reason(entry.check, file, entry.rule, entry.detail));
      const bad = OTHER.map((entry) => reason('lint', file, entry.rule, 'd'));`,
  },
  {
    name: 'a shadowing loop nested inside the real one',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) =>
        OTHER.map((entry) => reason('lint', file, entry.rule, 'd')),
      );`,
  },
  {
    name: 'a block-scoped re-declaration',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        { const entry = config; return reason('lint', file, entry.rule, 'd'); }
      });`,
  },
  {
    name: 'a catch-parameter re-declaration',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        try { go(); } catch (entry) { return reason('lint', file, entry.rule, 'd'); }
      });`,
  },
  {
    name: 'a destructured re-declaration',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        { const { entry } = config; return reason('lint', file, entry.rule, 'd'); }
      });`,
  },
  {
    name: 'a class declaration shadowing the parameter',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        { class entry {} return reason('lint', file, entry.rule, 'd'); }
      });`,
  },
  {
    name: 'a value-changing .map() upstream',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map(transform).map((entry) =>
        reason('lint', file, entry.rule, 'd'),
      );`,
  },
  {
    name: 'a reassigned parameter',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        entry = config;
        return reason('lint', file, entry.rule, 'd');
      });`,
  },
  {
    name: 'a directly mutated entry',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        entry.rule = computed;
        return reason('lint', file, entry.rule, 'd');
      });`,
  },
  {
    name: 'an entry passed somewhere else first',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        mutate(entry);
        return reason('lint', file, entry.rule, 'd');
      });`,
  },
  {
    name: 'a mutating upstream filter callback',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.filter((entry) => { entry.rule = computed; return true; })
        .map((entry) => reason('lint', file, entry.rule, 'd'));`,
  },
  {
    name: 'a member call on the entry before reading it',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.map((entry) => {
        entry.mutate();
        return reason('lint', file, entry.rule, 'd');
      });`,
  },
  {
    name: 'a template literal',
    source: "const a = reason('lint', file, `own:${platform}`, 'd');",
  },
  { name: 'a constant reference', source: "const a = reason('lint', file, RULE_ID, 'd');" },
];

for (const { name, source } of NOT_A_LITERAL) {
  test(`fails closed: ${name}`, () => {
    assert.throws(() => readSelectorRules('m.ts', source), /not a string literal/);
  });
}

test('a computed ownership-table rule fails closed too', () => {
  assert.throws(
    () =>
      readSelectorRules(
        'm.ts',
        "const T = [{ check: 'swift-runner', rule: buildRule('swift'), detail: 'd' }];",
      ),
    /build-ownership `rule:` is not a string literal/,
  );
});

// --- Declared forwards ------------------------------------------------------

/**
 * The live forwarding statement, on one line so its normalized fingerprint is obvious.
 *
 * The variants below keep this statement's inner `reason(...)` call byte for byte and change
 * only the chain around it. That is the point of fingerprinting the statement: an entry keyed on
 * the call alone accepts every one of them.
 */
const LIVE_STATEMENT =
  'const s = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) => ' +
  'reason(entry.check, file, entry.rule, entry.detail));';

const MUTATING_FILTER =
  'const s = BUILD_OWNERSHIP.filter((entry) => { entry.rule = computed; return true; })' +
  '.map((entry) => reason(entry.check, file, entry.rule, entry.detail));';

const MEMBER_CALL =
  'const s = BUILD_OWNERSHIP.map((entry) => { entry.mutate(); ' +
  'return reason(entry.check, file, entry.rule, entry.detail); });';

function inFunction(statement: string, enclosing = 'buildOwnership'): string {
  return `${TABLE}
    const ${enclosing} = () => {
      ${statement}
      return s;
    };
    const a = reason('lint', file, 'gate:lint', 'd');`;
}

const LIVE_KEY = { file: 'm.ts', enclosing: 'buildOwnership', statement: LIVE_STATEMENT };

test('a waiver admits exactly the statement it fingerprints, and loses no category', () => {
  const derived = readSelectorRules('m.ts', inFunction(LIVE_STATEMENT), [LIVE_KEY]);
  // `own:swift` is still there — read from the table entry, which is the whole reason the
  // forward is safe to declare: the waiver excuses the statement, it does not drop a category.
  assert.deepEqual(derived.rules, ['gate:lint', 'own:swift']);
  assert.deepEqual(derived.waiverMatches, [1]);
});

test('a waiver survives reformatting, because the statement text is normalized', () => {
  const rewrapped = inFunction(
    `const s = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map(
        (entry) => reason(entry.check, file, entry.rule, entry.detail),
      );`,
  );
  // Rewrapped across lines with extra indentation, but the same tokens: still one match. (The
  // trailing comma IS a token difference, so this variant keeps the argument list as written.)
  const normalized = LIVE_STATEMENT.replace(
    '.map((entry) => reason(entry.check, file, entry.rule, entry.detail));',
    '.map( (entry) => reason(entry.check, file, entry.rule, entry.detail), );',
  );
  const derived = readSelectorRules('m.ts', rewrapped, [{ ...LIVE_KEY, statement: normalized }]);
  assert.deepEqual(derived.rules, ['gate:lint', 'own:swift']);
  assert.deepEqual(derived.waiverMatches, [1]);
});

/**
 * The round-eight regressions: the two unsafe chains, each keeping the waived call verbatim.
 *
 * A waiver keyed on `reason(entry.check, file, entry.rule, entry.detail)` accepted all of these.
 * Keyed on the statement, every one is a different statement and fails closed.
 */
const BYPASS_ATTEMPTS: readonly { name: string; source: string }[] = [
  { name: 'a mutating upstream filter callback', source: inFunction(MUTATING_FILTER) },
  { name: 'a member call on the entry', source: inFunction(MEMBER_CALL) },
  {
    name: 'the waived statement relocated to another function',
    source: inFunction(LIVE_STATEMENT, 'somewhereElse'),
  },
  {
    name: 'the waived statement wrapped in a value-changing chain',
    source: inFunction(
      'const s = BUILD_OWNERSHIP.map(transform).map((entry) => ' +
        'reason(entry.check, file, entry.rule, entry.detail));',
    ),
  },
];

test('the bypass fixtures really do keep the waived call, or they prove nothing', () => {
  // Non-vacuity guard. These negatives only exercise the bypass while their inner call is byte
  // for byte the one a call-keyed waiver would have named; edit a fixture so the call differs
  // and they quietly degrade into ordinary "not a literal" cases that never touched the waiver.
  const call = 'reason(entry.check, file, entry.rule, entry.detail)';
  for (const statement of [LIVE_STATEMENT, MUTATING_FILTER, MEMBER_CALL]) {
    assert.ok(statement.includes(call), `fixture must contain the waived call: ${statement}`);
  }
});

for (const { name, source } of BYPASS_ATTEMPTS) {
  test(`the waiver does not admit: ${name}`, () => {
    assert.throws(() => readSelectorRules('m.ts', source, [LIVE_KEY]), /not a string literal/);
  });
}

test('a forward inside a block callback fingerprints the chain, not the bare return', () => {
  // The tightest statement around this forward is `return reason(…);`, which says nothing about
  // the chain that produced `entry`. Fingerprinting that would leave the chain swappable — the
  // same hole one shape over — so the key climbs to the outermost statement in the function.
  const blockForm =
    'const s = BUILD_OWNERSHIP.map((entry) => { return reason(entry.check, file, entry.rule, entry.detail); });';
  const bareReturn = 'return reason(entry.check, file, entry.rule, entry.detail);';

  assert.throws(
    () =>
      readSelectorRules('m.ts', inFunction(blockForm), [
        { file: 'm.ts', enclosing: 'buildOwnership', statement: bareReturn },
      ]),
    /not a string literal/,
    'a waiver naming only the return must not admit the chain around it',
  );
  const derived = readSelectorRules('m.ts', inFunction(blockForm), [
    { file: 'm.ts', enclosing: 'buildOwnership', statement: blockForm },
  ]);
  assert.deepEqual(derived.waiverMatches, [1]);
});

test('a waiver is bound to its file, so the same statement elsewhere is unreviewed', () => {
  assert.throws(
    () => readSelectorRules('other.ts', inFunction(LIVE_STATEMENT), [LIVE_KEY]),
    /not a string literal/,
  );
});

test('an unmatched waiver reports zero, so check.ts can call it inert', () => {
  const derived = readSelectorRules('m.ts', "const a = reason('lint', file, 'gate:lint', 'd');", [
    LIVE_KEY,
  ]);
  assert.deepEqual(derived.waiverMatches, [0]);
});

test('a waiver covering two identical statements reports both, so check.ts can refuse it', () => {
  // One reviewed claim must not silently spread to a second forward nobody looked at.
  const forward = 'use(BUILD_OWNERSHIP.map((entry) => reason(entry.check, file, entry.rule, 1)));';
  const source = `${TABLE}
    const buildOwnership = () => {
      ${forward}
      ${forward}
    };`;
  const derived = readSelectorRules('m.ts', source, [
    { file: 'm.ts', enclosing: 'buildOwnership', statement: forward },
  ]);
  assert.deepEqual(derived.waiverMatches, [2]);
});

test('the failure hands back the exact three fields a waiver needs', () => {
  try {
    readSelectorRules('m.ts', inFunction(LIVE_STATEMENT));
    assert.fail('expected a throw');
  } catch (error) {
    const message = String(error);
    assert.match(message, /file: {6}m\.ts/);
    assert.match(message, /enclosing: buildOwnership/);
    assert.match(
      message,
      new RegExp(`statement: ${LIVE_STATEMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  }
});

test('the failure names the line, and top-level forwards report as such', () => {
  try {
    readSelectorRules(
      'm.ts',
      "const ok = reason('lint', f, 'gate:lint', 'd');\nconst bad = reason('lint', f, X, 'd');",
    );
    assert.fail('expected a throw');
  } catch (error) {
    assert.match(String(error), /line 2/);
    assert.match(String(error), /enclosing: \(top level\)/);
    assert.match(String(error), /FORWARDED_SELECTOR_RULES/);
  }
});

// --- The real tree ----------------------------------------------------------

test("the repo's real selector derives, and its one declared forward is live", () => {
  const derived = readSelectorRules(
    SELECTOR_SOURCE,
    fs.readFileSync(path.join(repoRoot, SELECTOR_SOURCE), 'utf8'),
    FORWARDED_SELECTOR_RULES,
  );
  assert.ok(
    derived.rules.length >= 20,
    `expected the live selector to yield its categories, got ${derived.rules.length}`,
  );
  // Each declared forward matches exactly one real statement. check.ts fails the gate on 0 or
  // 2+; asserting it here means the unit lane catches a rotted waiver without the full manifest.
  assert.deepEqual(
    derived.waiverMatches,
    FORWARDED_SELECTOR_RULES.map(() => 1),
    'every FORWARDED_SELECTOR_RULES entry must fingerprint exactly one live statement',
  );
});

test("the repo's real selector fails closed with the waiver removed", () => {
  // Applied reachability, at the unit level: if this ever stops throwing, the waiver has become
  // an excuse for nothing and belongs deleted rather than carried.
  assert.throws(
    () =>
      readSelectorRules(
        SELECTOR_SOURCE,
        fs.readFileSync(path.join(repoRoot, SELECTOR_SOURCE), 'utf8'),
      ),
    /not a string literal/,
  );
});
