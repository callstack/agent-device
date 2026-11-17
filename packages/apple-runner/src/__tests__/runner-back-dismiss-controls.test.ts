import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildRunnerResponseError } from '../runner-contract.ts';

const RUNNER_HINT = 'Press the visible back or close control by its ref from a fresh snapshot.';

function backRefusal(code: string, dismissControls?: unknown) {
  return buildRunnerResponseError({
    ok: false,
    error: { code, message: 'The back swipe changed nothing.', hint: RUNNER_HINT, dismissControls },
  });
}

test('a back swipe that changed nothing publishes its lone dismiss control and names it in the hint', () => {
  const error = backRefusal('BACK_SWIPE_NO_CHANGE', [{ label: 'Close' }]);
  assert.equal(error.details?.reason, 'back_swipe_no_change');
  assert.deepEqual(error.details?.dismissControls, [
    { selector: 'role=button label="Close"', label: 'Close' },
  ]);
  assert.equal(
    error.details?.hint,
    `Press 'role=button label="Close"' to dismiss this screen; back only pops the navigation stack.`,
  );
});

test('a dismiss control with an identifier is selected by it', () => {
  const error = backRefusal('BACK_SWIPE_NO_CHANGE', [
    { label: 'xmark', identifier: 'sheet-close' },
  ]);
  assert.deepEqual(error.details?.dismissControls, [
    { selector: 'id="sheet-close"', label: 'xmark', identifier: 'sheet-close' },
  ]);
});

test('two dismiss controls are both published and the hint points at the list', () => {
  const error = backRefusal('BACK_SWIPE_NO_CHANGE', [{ label: 'Cancel' }, { label: 'Close' }]);
  assert.deepEqual(
    (error.details?.dismissControls as { label: string }[]).map((control) => control.label),
    ['Cancel', 'Close'],
  );
  assert.match(String(error.details?.hint), /one of details\.dismissControls/);
});

test('without dismiss controls the refusal keeps the runner hint and publishes no list', () => {
  for (const controls of [undefined, [], [{ identifier: 7 }], 'Close']) {
    const error = backRefusal('BACK_SWIPE_NO_CHANGE', controls);
    assert.equal(error.details?.dismissControls, undefined);
    assert.equal(error.details?.hint, RUNNER_HINT);
  }
});

test('only the no-change refusal publishes dismiss controls', () => {
  const error = backRefusal('BACK_SWIPE_UNVERIFIED', [{ label: 'Close' }]);
  assert.equal(error.details?.dismissControls, undefined);
  assert.equal(error.details?.hint, RUNNER_HINT);
});
