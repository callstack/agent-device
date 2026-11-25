import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatPinnedRef, REF_PIN_SEPARATOR } from '@agent-device/kernel/snapshot';
import { pinnedRefText } from './output-common.ts';

// `pinnedRefText` prints the ref pin for every partial CLI result. It spells the
// separator itself instead of calling the kernel owner, because this module sits in
// the CLI façade's eager module closure (see `output-common.ts`). These two tests
// make that freedom safe: the printed form must equal the owner's, and the owner's
// form must stay a plain literal word for the shells and command allow-rules that
// paste it.

test('pinnedRefText prints exactly the kernel owner form', () => {
  for (const [ref, generation] of [
    ['@e4', 434592],
    ['e4', 0],
    ['@e1001', 7],
  ] as const) {
    assert.equal(pinnedRefText(ref, generation), formatPinnedRef(ref, generation));
  }
  assert.equal(pinnedRefText('@e4', undefined), undefined);
  assert.equal(pinnedRefText('', 4), undefined);
});

test('a printed pin is a plain shell-literal word', () => {
  // Command allow-rule matchers parse the pasted command line before they apply an
  // allow rule, and they refuse an unquoted word holding a shell metacharacter. A
  // refused match runs the command sandboxed, where it cannot reach the daemon.
  const pin = pinnedRefText('@e4', 434592);
  assert.equal(pin, `@e4${REF_PIN_SEPARATOR}434592`);
  assert.match(pin, /^[A-Za-z0-9._:@/,+-]+$/);
  assert.notEqual(pin[0], '=');
});
