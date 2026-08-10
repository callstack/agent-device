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
 * Every shape that six rounds of review argued about, plus the two that ended the argument.
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
    // Round seven, first hole: the mutation is in an UPSTREAM callback, so a proof that only
    // looked at the forwarding callback saw nothing wrong with the map below it.
    name: 'a mutating upstream filter callback',
    source: `${TABLE}
      const bad = BUILD_OWNERSHIP.filter((entry) => { entry.rule = computed; return true; })
        .map((entry) => reason('lint', file, entry.rule, 'd'));`,
  },
  {
    // Round seven, second hole: `entry.mutate` is a member access whose object is `entry`, so a
    // read/write classifier counted invoking it as a read.
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
    assert.throws(() => readSelectorRules('m.ts', source), /rule argument is not a string literal/);
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

test('the failure names the line and quotes the call, so it can be waived or fixed', () => {
  try {
    readSelectorRules(
      'm.ts',
      "const ok = reason('lint', f, 'gate:lint', 'd');\nconst bad = reason('lint', f, X, 'd');",
    );
    assert.fail('expected a throw');
  } catch (error) {
    assert.match(String(error), /line 2/);
    assert.match(String(error), /reason\('lint', f, X, 'd'\)/);
    assert.match(String(error), /FORWARDED_SELECTOR_RULES/);
  }
});

// --- Declared forwards ------------------------------------------------------

const LIVE_CHAIN = `${TABLE}
  const s = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) =>
    reason(entry.check, file, entry.rule, entry.detail),
  );
  const a = reason('lint', file, 'gate:lint', 'd');`;

const LIVE_CALL = 'reason(entry.check, file, entry.rule, entry.detail)';

test('a waiver admits exactly the call it names, and the universe stays complete', () => {
  const derived = readSelectorRules('m.ts', LIVE_CHAIN, [LIVE_CALL]);
  // `own:swift` is still there — read from the table entry, which is the whole reason the
  // forward is safe to declare: the waiver excuses the call, it does not drop a category.
  assert.deepEqual(derived.rules, ['gate:lint', 'own:swift']);
  assert.equal(derived.waiverMatches.get(LIVE_CALL), 1);
});

test('a waiver matches across reformatting, because the text is normalized', () => {
  const rewrapped = `${TABLE}
    const s = BUILD_OWNERSHIP.map((entry) => reason(
        entry.check,
        file,
        entry.rule,
        entry.detail
    ));
    const a = reason('lint', file, 'gate:lint', 'd');`;
  assert.throws(
    () => readSelectorRules('m.ts', rewrapped, [LIVE_CALL]),
    /rule argument is not a string literal/,
    'a trailing-comma difference is a real text difference',
  );
  const normalized = 'reason( entry.check, file, entry.rule, entry.detail )';
  assert.deepEqual(readSelectorRules('m.ts', rewrapped, [normalized]).rules, [
    'gate:lint',
    'own:swift',
  ]);
});

test('a waiver does not admit a different forward in the same file', () => {
  const source = `${LIVE_CHAIN}
    const other = BUILD_OWNERSHIP.map((entry) => reason('lint', file, entry.rule, 'd'));`;
  assert.throws(
    () => readSelectorRules('m.ts', source, [LIVE_CALL]),
    /reason\('lint', file, entry\.rule, 'd'\)/,
  );
});

test('an unmatched waiver is reported as matching nothing, so check.ts can call it inert', () => {
  const derived = readSelectorRules('m.ts', "const a = reason('lint', file, 'gate:lint', 'd');", [
    LIVE_CALL,
  ]);
  assert.equal(derived.waiverMatches.get(LIVE_CALL), undefined);
});

test('a waiver covering two identical calls reports both, so check.ts can refuse it', () => {
  // One reviewed claim must not silently spread to a second call nobody looked at.
  const source = `${TABLE}
    const one = BUILD_OWNERSHIP.map((entry) => reason(entry.check, file, entry.rule, entry.detail));
    const two = OTHER.map((entry) => reason(entry.check, file, entry.rule, entry.detail));`;
  assert.equal(readSelectorRules('m.ts', source, [LIVE_CALL]).waiverMatches.get(LIVE_CALL), 2);
});

test("the repo's real selector derives, and its one declared forward is live", () => {
  const waived = FORWARDED_SELECTOR_RULES.map((entry) => entry.call);
  const derived = readSelectorRules(
    SELECTOR_SOURCE,
    fs.readFileSync(path.join(repoRoot, SELECTOR_SOURCE), 'utf8'),
    waived,
  );
  assert.ok(
    derived.rules.length >= 20,
    `expected the live selector to yield its categories, got ${derived.rules.length}`,
  );
  // Each declared forward matches exactly one real call. check.ts fails the gate on 0 or 2+;
  // asserting it here too means the unit lane catches a rotted waiver without the full manifest.
  for (const call of waived) {
    assert.equal(derived.waiverMatches.get(call), 1, `waiver "${call}" should match one call`);
  }
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
    /rule argument is not a string literal/,
  );
});
