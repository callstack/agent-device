import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { selector } from '../selector-read-utils.ts';
import { ambiguousSelectorReadSnapshot, createSelectorDevice } from './test-utils/index.ts';

/**
 * #1630: the read commands share one resolution interface and differ ONLY by
 * the `SELECTOR_RESOLUTION_POLICIES` row each names. resolution-policy-parity
 * proves what a row means to the engine; these prove which row each command
 * actually consumes, end to end, so re-pointing a caller at a different row
 * fails here instead of silently changing what `is` or `get` binds to.
 *
 * One ambiguous fixture drives all four, because that is the only screen on
 * which the rows disagree: a unique match resolves identically under every
 * one of them.
 */

const AMBIGUOUS_SELECTOR = 'label="Save"';

/** The tiebreak winner: deeper and smaller than its same-label ancestor. */
const DISAMBIGUATED_REF = '@e3';
/** Document order head, which the first-match rows take instead. */
const FIRST_MATCH_REF = '@e2';

test('get text disambiguates an ambiguous selector (readText row)', async () => {
  const device = createSelectorDevice(ambiguousSelectorReadSnapshot(), {
    readText: 'Save',
  });

  const result = await device.selectors.getText(selector(AMBIGUOUS_SELECTOR), {
    session: 'default',
  });

  assert.equal(result.kind, 'text');
  assert.equal(`@${result.node.ref}`, DISAMBIGUATED_REF);
});

test('get attrs fails closed on the same ambiguous selector (readUnique row)', async () => {
  const device = createSelectorDevice(ambiguousSelectorReadSnapshot());

  const error = await device.selectors
    .getAttrs(selector(AMBIGUOUS_SELECTOR), { session: 'default' })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );

  assert.ok(error instanceof AppError, 'get attrs must refuse rather than guess a duplicate');
  assert.equal(error.code, 'COMMAND_FAILED');
});

test('is fails closed on the same ambiguous selector (readUnique row)', async () => {
  const device = createSelectorDevice(ambiguousSelectorReadSnapshot());

  const error = await device.selectors
    .is({ session: 'default', predicate: 'visible', selector: AMBIGUOUS_SELECTOR })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );

  assert.ok(error instanceof AppError, 'is must refuse rather than answer about one duplicate');
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal((error.details as { reason?: string } | undefined)?.reason, 'selector_not_found');
});

test('find exists answers from the first match on the same tree (readAny row)', async () => {
  const device = createSelectorDevice(ambiguousSelectorReadSnapshot());

  const exists = await device.selectors.find({
    session: 'default',
    query: AMBIGUOUS_SELECTOR,
    action: 'exists',
  });
  assert.deepEqual(exists, { kind: 'found', found: true });

  // `list` renders the same domain the presence check answered from, so the
  // first-match pick above is the document-order head rather than a tiebreak
  // winner that happens to coincide with it.
  const listed = await device.selectors.find({
    session: 'default',
    query: AMBIGUOUS_SELECTOR,
    action: 'list',
  });
  assert.equal(listed.kind, 'list');
  assert.deepEqual(listed.kind === 'list' ? listed.matches.map((match) => match.ref) : [], [
    FIRST_MATCH_REF,
    DISAMBIGUATED_REF,
  ]);
});
