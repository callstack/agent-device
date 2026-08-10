// Deriving the affected-selector's category universe from its source.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { selectorRuleIds } from './selector-rules.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const SELECTOR_SOURCE = 'scripts/check-affected/model.ts';

test('literal rules are collected from both reason() calls and the ownership table', () => {
  const source = `
    function reason(check, file, rule, detail) { return { check, path: file, rule, detail }; }
    const BUILD_OWNERSHIP = [{ check: 'swift-runner', rule: 'own:swift', detail: 'd', owns: () => true }];
    const a = reason('lint', file, 'gate:lint', 'oxlint covers the source tree');
    const b = BUILD_OWNERSHIP.map((entry) => reason(entry.check, file, entry.rule, entry.detail));
  `;
  assert.deepEqual(selectorRuleIds('m.ts', source), ['gate:lint', 'own:swift']);
});

test('a fail-open literal is not a category, because it pairs rule: with path:', () => {
  const source = `
    const a = reason('lint', file, 'gate:lint', 'd');
    const open = { path: file, rule: 'workflow-tooling', detail: 'anything can change' };
  `;
  assert.deepEqual(selectorRuleIds('m.ts', source), ['gate:lint']);
});

test('an arbitrary .rule member access is NOT an exempt forwarding shape', () => {
  // The exemption exists only for a binding proven to iterate the collected ownership table.
  // Accepting any member named `.rule` would silently skip a category this reader never sees,
  // while the other literal categories keep the derived-universe gate green.
  assert.throws(
    () => selectorRuleIds('m.ts', "const a = reason('lint', file, config.rule, 'd');"),
    /rule argument is not a string literal/,
  );
  // Same shape, but iterating an array that is not an ownership table: still not proven.
  assert.throws(
    () =>
      selectorRuleIds(
        'm.ts',
        `const OTHER = [{ id: 'x', rule: 'not-a-category' }];
         const a = OTHER.map((entry) => reason('lint', file, entry.rule, 'd'));`,
      ),
    /rule argument is not a string literal/,
  );
  // And a binding named `entry` that never came from a table does not inherit the exemption.
  assert.throws(
    () => selectorRuleIds('m.ts', "const a = reason('lint', file, entry.rule, 'd');"),
    /rule argument is not a string literal/,
  );
});

test('forwarding from the real ownership-table iteration is exempt and loses no category', () => {
  const source = `
    const BUILD_OWNERSHIP = [
      { check: 'swift-runner', rule: 'own:swift', detail: 'd', owns: () => true },
      { check: 'macos-helper', rule: 'own:macos-helper', detail: 'd', owns: () => true },
    ];
    const a = reason('lint', file, 'gate:lint', 'd');
    const b = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) =>
      reason(entry.check, file, entry.rule, entry.detail),
    );
  `;
  assert.deepEqual(selectorRuleIds('m.ts', source), ['gate:lint', 'own:macos-helper', 'own:swift']);
});

test("the reason factory's own return object declares no category", () => {
  // `return { check, path: file, rule, detail }` pairs check with rule and would otherwise read
  // as a build-ownership entry whose rule is not a literal. It is excluded by the factory's
  // source span, not by "any shorthand rule" — which would also swallow a real table entry.
  const source = `
    function reason(check, file, rule, detail) { return { check, path: file, rule, detail }; }
    const a = reason('lint', file, 'gate:lint', 'd');
  `;
  assert.deepEqual(selectorRuleIds('m.ts', source), ['gate:lint']);
});

test('the exemption follows the lexical binding, not the name `entry`', () => {
  // One file, both shapes. The real BUILD_OWNERSHIP loop contributes a binding spelled `entry`;
  // that must not make an unrelated `entry.rule` elsewhere in the file exempt too.
  const source = `
    const BUILD_OWNERSHIP = [{ check: 'swift-runner', rule: 'own:swift', detail: 'd', owns: () => true }];
    const good = BUILD_OWNERSHIP.map((entry) => reason(entry.check, file, entry.rule, entry.detail));
    const bad = OTHER.map((entry) => reason('lint', file, entry.rule, 'd'));
  `;
  assert.throws(() => selectorRuleIds('m.ts', source), /rule argument is not a string literal/);
});

test('a shadowing binding inside the real ownership loop is still rejected', () => {
  // The inner `entry` shadows the ownership-table one, so its `.rule` is not a collected
  // literal. Span containment alone would wrongly exempt it; the innermost binder decides.
  const source = `
    const BUILD_OWNERSHIP = [{ check: 'swift-runner', rule: 'own:swift', detail: 'd', owns: () => true }];
    const nested = BUILD_OWNERSHIP.map((entry) =>
      OTHER.map((entry) => reason('lint', file, entry.rule, 'd')),
    );
  `;
  assert.throws(() => selectorRuleIds('m.ts', source), /rule argument is not a string literal/);
});

test('the real ownership loop stays exempt when no impostor shares its name', () => {
  const source = `
    const BUILD_OWNERSHIP = [
      { check: 'swift-runner', rule: 'own:swift', detail: 'd', owns: () => true },
    ];
    const good = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) =>
      reason(entry.check, file, entry.rule, entry.detail),
    );
    const other = OTHER.map((row) => row.id);
    const a = reason('lint', file, 'gate:lint', 'd');
  `;
  assert.deepEqual(selectorRuleIds('m.ts', source), ['gate:lint', 'own:swift']);
});

test('a computed rule argument fails closed rather than being skipped', () => {
  // A category this reader cannot see would bypass the representative-sample and reachability
  // checks entirely — the exact hole the derived universe exists to close.
  assert.throws(
    () => selectorRuleIds('m.ts', "const a = reason('lint', file, `own:${platform}`, 'd');"),
    /not statically readable[\s\S]*rule argument is not a string literal/,
  );
  assert.throws(
    () => selectorRuleIds('m.ts', "const a = reason('lint', file, RULE_ID, 'd');"),
    /rule argument is not a string literal/,
  );
});

test('a computed ownership-table rule fails closed too', () => {
  assert.throws(
    () =>
      selectorRuleIds(
        'm.ts',
        "const T = [{ check: 'swift-runner', rule: buildRule('swift'), detail: 'd' }];",
      ),
    /build-ownership `rule:` is not a string literal/,
  );
});

test('the failure names the line so the selector can be fixed', () => {
  try {
    selectorRuleIds(
      'm.ts',
      "const ok = reason('lint', f, 'gate:lint', 'd');\nconst bad = reason('lint', f, X, 'd');",
    );
    assert.fail('expected a throw');
  } catch (error) {
    assert.match(String(error), /line 2/);
  }
});

test("the repo's real selector still derives without hitting a fail-closed shape", () => {
  const rules = selectorRuleIds(
    SELECTOR_SOURCE,
    fs.readFileSync(path.join(repoRoot, SELECTOR_SOURCE), 'utf8'),
  );
  assert.ok(
    rules.length >= 20,
    `expected the live selector to yield its categories, got ${rules.length}`,
  );
});
