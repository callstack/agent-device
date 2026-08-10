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
