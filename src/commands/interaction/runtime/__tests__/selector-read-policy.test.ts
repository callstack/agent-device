import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { selector } from '../selector-read-utils.ts';
import {
  ambiguousSelectorReadSnapshot,
  createSelectorDevice,
  skippedAlternativeSelectorSnapshot,
} from './test-utils/index.ts';

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

test('is exists answers from the first matching alternative (readAny row)', async () => {
  const device = createSelectorDevice(skippedAlternativeSelectorSnapshot());

  // `exists` exposes no node ref, so the row has to be read off WHICH
  // alternative answered. On a fixture whose first alternative is merely
  // tiebreakable, `pass: true` + the same count come out of first-match,
  // disambiguation, and the pre-#1630 raw lookup alike — which is why the
  // first alternative here is an undecidable tie: only a first-match row
  // answers from it (#1715 review).
  const result = await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label="Save" || id="save-unique"',
  });

  assert.equal(result.pass, true);
  assert.equal(result.selector, 'label="Save"');
  assert.equal(result.matches, 2);
});

test('is exists tolerates the ambiguity its sibling predicates refuse (readAny row)', async () => {
  const device = createSelectorDevice(ambiguousSelectorReadSnapshot());

  // Caller-facing contrast on the shared fixture: the same screen and selector
  // the fail-closed `is` above refuses, answered here because presence is a
  // different question from "which one".
  const result = await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: AMBIGUOUS_SELECTOR,
  });

  assert.equal(result.pass, true);
  assert.equal(result.matches, 2);
});

test('find takes the document-order head on the same tree (readAny row)', async () => {
  const device = createSelectorDevice(ambiguousSelectorReadSnapshot());

  // `get_attrs`, not `exists`: WHICH node the row selected has to be
  // observable, or the assertion cannot separate `readAny` from the
  // disambiguating row — `found: true` holds either way while the selection
  // silently moves to the tiebreak winner (#1715 review).
  const attrs = await device.selectors.find({
    session: 'default',
    query: AMBIGUOUS_SELECTOR,
    action: 'get_attrs',
  });
  assert.equal(attrs.kind, 'attrs');
  assert.equal(attrs.kind === 'attrs' ? attrs.ref : undefined, FIRST_MATCH_REF);

  // The presence contract rides the same resolution, so a row that refuses an
  // ambiguous screen would fail here rather than answering `found: true`.
  const exists = await device.selectors.find({
    session: 'default',
    query: AMBIGUOUS_SELECTOR,
    action: 'exists',
  });
  assert.deepEqual(exists, { kind: 'found', found: true });
});
