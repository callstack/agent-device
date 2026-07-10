import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import {
  formatTargetAnnotationCommentLine,
  matchesAncestryPrefix,
  matchesLocalIdentity,
  normalizeLabelField,
  parseTargetAnnotationCommentLine,
  parseTargetAnnotationV1Payload,
  serializeTargetAnnotationV1,
  truncateToUtf8Bytes,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
  type TargetAnnotationV1,
} from '../target-identity.ts';

function baseEvidence(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
  return {
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [{ role: 'toolbar', label: 'Editor' }, { role: 'window' }],
    sibling: 0,
    viewportOrder: 0,
    scrollRegion: { role: 'scrollview', id: 'editor-scroll' },
    verification: 'verified',
    ...overrides,
  };
}

function assertInvalidArgs(fn: () => unknown, messagePattern?: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      (!messagePattern || messagePattern.test(error.message)),
  );
}

// ---------------------------------------------------------------------------
// Canonical serialization / field order
// ---------------------------------------------------------------------------

test('serializeTargetAnnotationV1 uses the exact canonical field order from decision 3', () => {
  const json = serializeTargetAnnotationV1(baseEvidence());
  assert.equal(
    json,
    '{"id":"save","role":"button","label":"Save","ancestry":[{"role":"toolbar","label":"Editor"},{"role":"window"}],"sibling":0,"viewportOrder":0,"scrollRegion":{"role":"scrollview","id":"editor-scroll"},"verification":"verified"}',
  );
});

test('formatTargetAnnotationCommentLine emits the ASCII # agent-device:target-v1 prefix', () => {
  const line = formatTargetAnnotationCommentLine(baseEvidence());
  assert.ok(line.startsWith('# agent-device:target-v1 {'));
});

// ---------------------------------------------------------------------------
// Parse-write-parse round trip / semantic equality
// ---------------------------------------------------------------------------

test('parse(serialize(evidence)) round trips to a semantically equal object', () => {
  const evidence = baseEvidence({ rect: { x: 1, y: 2, width: 3, height: 4 } });
  const parsedBack = parseTargetAnnotationV1Payload(serializeTargetAnnotationV1(evidence));
  assert.deepEqual(parsedBack, evidence);
});

test('parseTargetAnnotationCommentLine accepts known fields in any JSON key order', () => {
  const line =
    '# agent-device:target-v1 {"verification":"verified","sibling":0,"role":"button","viewportOrder":2,"ancestry":[],"id":"save"}';
  const result = parseTargetAnnotationCommentLine(line);
  assert.equal(result.kind, 'v1');
  if (result.kind !== 'v1') throw new Error('unreachable');
  assert.deepEqual(result.evidence, {
    id: 'save',
    role: 'button',
    ancestry: [],
    sibling: 0,
    viewportOrder: 2,
    verification: 'verified',
  });
});

test('parseTargetAnnotationCommentLine ignores unknown fields', () => {
  const line =
    '# agent-device:target-v1 {"role":"button","verification":"verified","futureField":{"nested":true}}';
  const result = parseTargetAnnotationCommentLine(line);
  assert.equal(result.kind, 'v1');
  if (result.kind !== 'v1') throw new Error('unreachable');
  assert.equal((result.evidence as Record<string, unknown>).futureField, undefined);
});

test('an unknown future target-vN annotation is an ordinary comment to a v1 reader', () => {
  const result = parseTargetAnnotationCommentLine('# agent-device:target-v2 {"anything":"goes"}');
  assert.deepEqual(result, { kind: 'future-version' });
});

test('a line that merely mentions the tag in prose is an ordinary comment', () => {
  assert.deepEqual(parseTargetAnnotationCommentLine('# see agent-device:target-v1 docs'), {
    kind: 'none',
  });
  assert.deepEqual(parseTargetAnnotationCommentLine('# just a comment'), { kind: 'none' });
});

// ---------------------------------------------------------------------------
// Normalization: NFC, label trim/collapse, normalized-role source
// ---------------------------------------------------------------------------

test('normalizeLabelField NFC-normalizes, trims, and collapses internal whitespace', () => {
  // "é" as e + combining acute (NFD) must normalize to the precomposed (NFC) form.
  const nfd = 'Café';
  assert.equal(normalizeLabelField(`  ${nfd}   au   lait  `), 'Café au lait');
});

test('normalizeLabelField treats a whitespace-only label as absent', () => {
  assert.equal(normalizeLabelField('   '), undefined);
});

test('embedded quotes and backslashes in labels round trip losslessly', () => {
  const evidence = baseEvidence({ label: 'Say "hi" \\ backslash', id: undefined });
  const json = serializeTargetAnnotationV1(evidence);
  assert.ok(json.includes('\\"hi\\"'));
  const parsed = parseTargetAnnotationV1Payload(json);
  assert.equal(parsed.label, 'Say "hi" \\ backslash');
});

test('Unicode labels (including astral code points) round trip losslessly', () => {
  const evidence = baseEvidence({ label: '\u{1F600} café résumé', id: undefined });
  const parsed = parseTargetAnnotationV1Payload(serializeTargetAnnotationV1(evidence));
  assert.equal(parsed.label, '\u{1F600} café résumé');
});

// ---------------------------------------------------------------------------
// Old/new reader compatibility
// ---------------------------------------------------------------------------

test('a v1 reader treats an annotation with only role + verification as valid, defaulting the rest', () => {
  const result = parseTargetAnnotationCommentLine(
    '# agent-device:target-v1 {"role":"button","verification":"verified"}',
  );
  assert.equal(result.kind, 'v1');
  if (result.kind !== 'v1') throw new Error('unreachable');
  assert.deepEqual(result.evidence, {
    role: 'button',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  });
});

// ---------------------------------------------------------------------------
// Leaf-anchored ancestry prefix matching: root-side truncation + inserted
// wrapper mismatch
// ---------------------------------------------------------------------------

test('matchesAncestryPrefix accepts an observed chain that is a superset on the root side (truncation)', () => {
  const recorded = [{ role: 'toolbar', label: 'Editor' }];
  const observedFullDepth = [
    { role: 'toolbar', label: 'Editor' },
    { role: 'window' },
    { role: 'application' },
  ];
  assert.equal(matchesAncestryPrefix(observedFullDepth, recorded), true);
});

test('matchesAncestryPrefix rejects an inserted wrapper ancestor (structure is part of identity)', () => {
  const recorded = [{ role: 'toolbar', label: 'Editor' }, { role: 'window' }];
  // A new wrapper view inserted directly above the target shifts every entry
  // one level down — the leaf-anchored prefix no longer matches.
  const observedWithInsertedWrapper = [
    { role: 'view' },
    { role: 'toolbar', label: 'Editor' },
    { role: 'window' },
  ];
  assert.equal(matchesAncestryPrefix(observedWithInsertedWrapper, recorded), false);
});

test('matchesAncestryPrefix rejects a shorter observed chain', () => {
  const recorded = [{ role: 'toolbar' }, { role: 'window' }];
  assert.equal(matchesAncestryPrefix([{ role: 'toolbar' }], recorded), false);
});

test('matchesAncestryPrefix leaves an unconstrained (absent) recorded label unconstrained', () => {
  const recorded = [{ role: 'toolbar' }];
  assert.equal(matchesAncestryPrefix([{ role: 'toolbar', label: 'anything' }], recorded), true);
});

// ---------------------------------------------------------------------------
// Local identity
// ---------------------------------------------------------------------------

test('matchesLocalIdentity: a recorded id never matches a node without that id', () => {
  assert.equal(matchesLocalIdentity({ role: 'button' }, { id: 'save', role: 'button' }), false);
});

test('matchesLocalIdentity: with no recorded id, role+label must both match, absent-absent counts as equal', () => {
  assert.equal(matchesLocalIdentity({ role: 'button' }, { role: 'button' }), true);
  assert.equal(matchesLocalIdentity({ role: 'button', label: 'Save' }, { role: 'button' }), false);
});

// ---------------------------------------------------------------------------
// Bounds: 256-byte fields, 4 KiB payload, 8-entry ancestry — parser REJECTS,
// never truncates.
// ---------------------------------------------------------------------------

test('parser rejects a string field exceeding the 256-byte cap', () => {
  const oversizedLabel = 'x'.repeat(TARGET_ANNOTATION_MAX_FIELD_BYTES + 1);
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', label: oversizedLabel, verification: 'verified' }),
      ),
    /256-byte field cap/,
  );
});

test('parser rejects a payload exceeding the 4 KiB cap', () => {
  // Every individual field stays within the 256-byte field cap, but 8
  // maxed-out ancestry entries plus maxed top-level/scrollRegion fields blow
  // the 4 KiB payload ceiling collectively.
  const maxLabel = 'x'.repeat(TARGET_ANNOTATION_MAX_FIELD_BYTES);
  const ancestry = Array.from({ length: TARGET_ANNOTATION_MAX_ANCESTRY }, () => ({
    role: maxLabel,
    label: maxLabel,
  }));
  const json = JSON.stringify({
    id: maxLabel,
    role: maxLabel,
    label: maxLabel,
    ancestry,
    scrollRegion: { role: maxLabel, id: maxLabel, label: maxLabel },
    verification: 'verified',
  });
  assert.ok(Buffer.byteLength(json, 'utf8') > TARGET_ANNOTATION_MAX_PAYLOAD_BYTES);
  assertInvalidArgs(() => parseTargetAnnotationV1Payload(json), /4096-byte payload cap/);
});

test('parser rejects more than 8 ancestry entries', () => {
  const ancestry = Array.from({ length: TARGET_ANNOTATION_MAX_ANCESTRY + 1 }, () => ({
    role: 'view',
  }));
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', ancestry, verification: 'verified' }),
      ),
    /8-entry cap/,
  );
});

test('truncateToUtf8Bytes never splits a surrogate pair', () => {
  const emoji = '\u{1F600}'; // 4 UTF-8 bytes, a surrogate pair in UTF-16
  const truncated = truncateToUtf8Bytes(`ab${emoji}`, 3);
  assert.equal(Buffer.byteLength(truncated, 'utf8') <= 3, true);
  // The budget (3 bytes) fits "ab" but not the 4-byte emoji — the whole
  // surrogate pair must be dropped together, never split.
  assert.equal(truncated, 'ab');
  assert.equal(/[\ud800-\udbff]$/.test(truncated), false);
});

// ---------------------------------------------------------------------------
// Malformed / unbound annotations
// ---------------------------------------------------------------------------

test('parser rejects non-JSON payloads', () => {
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('{not json'), /valid JSON/);
});

test('parser rejects a JSON array or scalar payload', () => {
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('[]'));
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('"button"'));
});

test('parser rejects a wrong-typed known field', () => {
  assertInvalidArgs(() =>
    parseTargetAnnotationV1Payload(JSON.stringify({ role: 42, verification: 'verified' })),
  );
});

test('parser rejects an invalid verification value', () => {
  assertInvalidArgs(() =>
    parseTargetAnnotationV1Payload(JSON.stringify({ role: 'button', verification: 'maybe' })),
  );
});

test('parser rejects a negative or non-integer sibling/viewportOrder', () => {
  assertInvalidArgs(() =>
    parseTargetAnnotationV1Payload(
      JSON.stringify({ role: 'button', sibling: -1, verification: 'verified' }),
    ),
  );
  assertInvalidArgs(() =>
    parseTargetAnnotationV1Payload(
      JSON.stringify({ role: 'button', viewportOrder: 1.5, verification: 'verified' }),
    ),
  );
});

// ---------------------------------------------------------------------------
// rect is diagnostic only: parsed, bounded, but never a comparison input at
// this parser layer (there is no comparator here yet — decision 3's
// enforcement lands in a later migration step — this just proves the parser
// accepts/round-trips it as inert data).
// ---------------------------------------------------------------------------

test('rect parses and round trips but carries no comparison semantics here', () => {
  const evidence = baseEvidence({ rect: { x: 10, y: 20, width: 30, height: 40 } });
  const parsed = parseTargetAnnotationV1Payload(serializeTargetAnnotationV1(evidence));
  assert.deepEqual(parsed.rect, { x: 10, y: 20, width: 30, height: 40 });
});

test('parser rejects a malformed rect', () => {
  assertInvalidArgs(() =>
    parseTargetAnnotationV1Payload(
      JSON.stringify({ role: 'button', rect: { x: 1, y: 2 }, verification: 'verified' }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Role presence: the writer emits `role` unconditionally (top level, every
// ancestry entry, scrollRegion) — possibly as the empty string for a
// typeless node, which stays accepted. A MISSING role key can only come from
// a hand-edited/adversarial annotation and must be rejected, or step-4
// enforcement could match anonymous wrapper nodes through an implicit
// empty-role identity.
// ---------------------------------------------------------------------------

test('parser rejects a missing top-level role', () => {
  assertInvalidArgs(
    () => parseTargetAnnotationV1Payload(JSON.stringify({ verification: 'verified' })),
    /"role" is required/,
  );
});

test('parser rejects a missing role in an ancestry entry and in scrollRegion', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({
          role: 'button',
          ancestry: [{ label: 'Editor' }],
          verification: 'verified',
        }),
      ),
    /"ancestry\[0\]\.role" is required/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', scrollRegion: { id: 'list' }, verification: 'verified' }),
      ),
    /"scrollRegion\.role" is required/,
  );
});

test('parser accepts an explicit empty-string role (writer-legal for typeless nodes)', () => {
  const parsed = parseTargetAnnotationV1Payload(
    JSON.stringify({ role: '', ancestry: [{ role: '' }], verification: 'verified' }),
  );
  assert.equal(parsed.role, '');
  assert.deepEqual(parsed.ancestry, [{ role: '' }]);
});
