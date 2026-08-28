import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  formatMultiTargetAnnotationCommentLine,
  formatTargetAnnotationCommentLine,
  normalizeLabelField,
  parseMultiTargetAnnotationCommentLine,
  parseMultiTargetAnnotationV1Payload,
  parseTargetAnnotationCommentLine,
  parseTargetAnnotationV1Payload,
  serializeMultiTargetAnnotationV1,
  serializeTargetAnnotationV1,
  truncateToUtf8Bytes,
  TARGET_ANNOTATION_MAX_ANCESTRY,
  TARGET_ANNOTATION_MAX_FIELD_BYTES,
  TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
  TARGET_ANNOTATION_LINE_RE,
  MULTI_TARGET_ANNOTATION_MAX_PAYLOAD_BYTES,
} from '../target-annotation-serde.ts';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';

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

test('targets-v1 canonically round-trips source and destination evidence', () => {
  const evidence = {
    source: baseEvidence({ id: 'source', label: 'Source' }),
    destination: baseEvidence({ id: 'destination', label: 'Destination' }),
  };
  const serialized = serializeMultiTargetAnnotationV1(evidence);
  assert.deepEqual(parseMultiTargetAnnotationV1Payload(serialized), evidence);
  const parsed = parseMultiTargetAnnotationCommentLine(
    formatMultiTargetAnnotationCommentLine(evidence),
  );
  assert.deepEqual(parsed, { kind: 'v1', evidence });
});

test('targets-v1 rejects a payload missing either endpoint', () => {
  assertInvalidArgs(
    () => parseMultiTargetAnnotationV1Payload('{"source":{"role":"view"}}'),
    /requires source and destination/,
  );
});

test('targets-v1 rejects a wrapper above its bounded two-target payload cap', () => {
  assertInvalidArgs(
    () =>
      parseMultiTargetAnnotationV1Payload(
        JSON.stringify({ padding: 'x'.repeat(MULTI_TARGET_ANNOTATION_MAX_PAYLOAD_BYTES) }),
      ),
    /exceeds the .*byte payload cap/,
  );
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

test('a line that is not a comment at all is not a target annotation', () => {
  assert.deepEqual(parseTargetAnnotationCommentLine('const x = 1;'), { kind: 'none' });
});

test('leading and trailing whitespace around the annotation line does not break parsing', () => {
  const result = parseTargetAnnotationCommentLine(
    '   # agent-device:target-v1 {"role":"button","verification":"verified"}   ',
  );
  assert.equal(result.kind, 'v1');
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

test('an empty-string id is treated as absent, like a whitespace-only label', () => {
  const parsed = parseTargetAnnotationV1Payload(
    JSON.stringify({ id: '', role: 'button', verification: 'verified' }),
  );
  assert.equal(parsed.id, undefined);
});

test('scrollRegion.label serializes and round trips like every other label field', () => {
  const evidence = baseEvidence({
    id: undefined,
    label: undefined,
    scrollRegion: { role: 'scrollview', id: 'editor-scroll', label: 'Body' },
  });
  const json = serializeTargetAnnotationV1(evidence);
  assert.ok(
    json.includes('"scrollRegion":{"role":"scrollview","id":"editor-scroll","label":"Body"}'),
  );
  const parsed = parseTargetAnnotationV1Payload(json);
  assert.equal(parsed.scrollRegion?.label, 'Body');
});

test('embedded quotes and backslashes in labels round trip losslessly', () => {
  const evidence = baseEvidence({ label: 'Say "hi" \\ backslash', id: undefined });
  const json = serializeTargetAnnotationV1(evidence);
  assert.ok(json.includes(String.raw`\"hi\"`));
  const parsed = parseTargetAnnotationV1Payload(json);
  assert.equal(parsed.label, String.raw`Say "hi" \ backslash`);
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

test('parser accepts a payload landing exactly on the 4 KiB cap boundary', () => {
  // A fixed filler length below the field cap on every other string field,
  // plus one tunable ancestry-entry role (also within its own 256-byte field
  // cap) sized by exact arithmetic — every character is ASCII, so 1 char is 1
  // UTF-8 byte, and the tunable field's required length is computable
  // directly rather than searched for.
  const FILLER = 'x'.repeat(180);
  const build = (padLength: number) => {
    const ancestry = Array.from({ length: TARGET_ANNOTATION_MAX_ANCESTRY }, (_unused, index) => ({
      role: index === 0 ? 'x'.repeat(padLength) : FILLER,
      label: index === 0 ? undefined : FILLER,
    }));
    return JSON.stringify({
      id: FILLER,
      role: FILLER,
      label: FILLER,
      ancestry,
      scrollRegion: { role: FILLER, id: FILLER, label: FILLER },
      verification: 'verified',
    });
  };
  const base = Buffer.byteLength(build(0), 'utf8');
  const padLength = TARGET_ANNOTATION_MAX_PAYLOAD_BYTES - base;
  assert.ok(
    padLength >= 0 && padLength <= TARGET_ANNOTATION_MAX_FIELD_BYTES,
    `fixture no longer straddles the cap (base ${base}, needs pad ${padLength})`,
  );
  const json = build(padLength);
  assert.equal(Buffer.byteLength(json, 'utf8'), TARGET_ANNOTATION_MAX_PAYLOAD_BYTES);
  assert.doesNotThrow(() => parseTargetAnnotationV1Payload(json));
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

test('truncateToUtf8Bytes drops a lone high surrogate at either end of its range', () => {
  // Codepoint 0x10000 encodes to the lowest high surrogate (0xD800); 0x10FFFF
  // (the last valid Unicode codepoint) encodes to the highest (0xDBFF). Both
  // bound cases must trigger the drop, not just a value in the middle of the
  // range.
  for (const codepoint of [0x10000, 0x10ffff]) {
    const astral = String.fromCodePoint(codepoint);
    const truncated = truncateToUtf8Bytes(`a${astral}`, 4);
    assert.equal(truncated, 'a', `codepoint 0x${codepoint.toString(16)} left a lone surrogate`);
  }
});

test('truncateToUtf8Bytes keeps a fully-paired surrogate that lands exactly on the byte budget', () => {
  // The budget lands the cut right after a complete surrogate pair (trimming
  // only the unrelated trailing "cd"), so nothing here is a split — the
  // dangling-high-surrogate guard must NOT also fire on the pair's low half.
  const astral = String.fromCodePoint(0x10000);
  const truncated = truncateToUtf8Bytes(`ab${astral}cd`, 6);
  assert.equal(truncated, `ab${astral}`);
});

// ---------------------------------------------------------------------------
// Malformed / unbound annotations
// ---------------------------------------------------------------------------

test('parser rejects non-JSON payloads', () => {
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('{not json'), /valid JSON/);
});

test('parser rejects a JSON array or scalar payload', () => {
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('[]'), /must be a JSON object/);
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('"button"'), /must be a JSON object/);
});

// `typeof null === 'object'` in JS, so a bare `null` payload passes the
// typeof check above and needs its own explicit rejection — the array/scalar
// test above cannot exercise this branch.
test('parser rejects a null payload', () => {
  assertInvalidArgs(() => parseTargetAnnotationV1Payload('null'), /must be a JSON object/);
});

test('parser rejects a wrong-typed known field', () => {
  assertInvalidArgs(
    () => parseTargetAnnotationV1Payload(JSON.stringify({ role: 42, verification: 'verified' })),
    /"role" must be a string/,
  );
});

test('parser rejects wrong-typed optional id and label fields, naming each in the message', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ id: 42, role: 'button', verification: 'verified' }),
      ),
    /"id" must be a string/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', label: 42, verification: 'verified' }),
      ),
    /"label" must be a string/,
  );
});

test('parser rejects ancestry that is not an array', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', ancestry: 'toolbar', verification: 'verified' }),
      ),
    /"ancestry" must be an array/,
  );
});

test('parser rejects an ancestry entry that is not an object', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', ancestry: ['toolbar'], verification: 'verified' }),
      ),
    /"ancestry\[0\]" must be an object/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', ancestry: [null], verification: 'verified' }),
      ),
    /"ancestry\[0\]" must be an object/,
  );
});

test('parser rejects a scrollRegion or rect that is not an object', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', scrollRegion: 'list', verification: 'verified' }),
      ),
    /"scrollRegion" must be an object/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', rect: 'somewhere', verification: 'verified' }),
      ),
    /"rect" must be an object/,
  );
});

// `typeof null === 'object'`, so a null scrollRegion/rect needs its own
// explicit rejection — same trap as the top-level null-payload case above.
// Getting this wrong crashes on `null.role`/`null.x` (a raw TypeError)
// instead of a graceful AppError, unlike the string-typed case above.
test('parser rejects a null scrollRegion or rect with AppError, not a native crash on null property access', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', scrollRegion: null, verification: 'verified' }),
      ),
    /"scrollRegion" must be an object/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', rect: null, verification: 'verified' }),
      ),
    /"rect" must be an object/,
  );
});

test('parser rejects an invalid verification value', () => {
  assertInvalidArgs(
    () => parseTargetAnnotationV1Payload(JSON.stringify({ role: 'button', verification: 'maybe' })),
    /"verification" must be "verified" or "unverifiable"/,
  );
});

test('parser rejects a negative or non-integer sibling/viewportOrder, naming each in the message', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', sibling: -1, verification: 'verified' }),
      ),
    /"sibling" must be a non-negative integer/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({ role: 'button', viewportOrder: 1.5, verification: 'verified' }),
      ),
    /"viewportOrder" must be a non-negative integer/,
  );
});

test('parser rejects a wrong-typed scrollRegion.id and scrollRegion.label, naming each in the message', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({
          role: 'button',
          scrollRegion: { role: 'list', id: 42 },
          verification: 'verified',
        }),
      ),
    /"id" must be a string/,
  );
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({
          role: 'button',
          scrollRegion: { role: 'list', label: 42 },
          verification: 'verified',
        }),
      ),
    /"scrollRegion\.label" must be a string/,
  );
});

test('parser rejects a wrong-typed ancestry entry label, naming it in the message', () => {
  assertInvalidArgs(
    () =>
      parseTargetAnnotationV1Payload(
        JSON.stringify({
          role: 'button',
          ancestry: [{ role: 'toolbar', label: 42 }],
          verification: 'verified',
        }),
      ),
    /"ancestry\[0\]\.label" must be a string/,
  );
});

test('parser rejects a wrong-typed rect field, naming each in the message', () => {
  for (const field of ['x', 'y', 'width', 'height']) {
    assertInvalidArgs(
      () =>
        parseTargetAnnotationV1Payload(
          JSON.stringify({
            role: 'button',
            rect: { x: 1, y: 2, width: 3, height: 4, [field]: 'nope' },
            verification: 'verified',
          }),
        ),
      new RegExp(`"rect\\.${field}" must be a finite number`),
    );
  }
});

test('a whitespace-only label collapses to absent through the full parse, not just the normalizer', () => {
  const parsed = parseTargetAnnotationV1Payload(
    JSON.stringify({ role: 'button', label: '   ', verification: 'verified' }),
  );
  assert.equal(parsed.label, undefined);
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

// ---------------------------------------------------------------------------
// CodeQL js/polynomial-redos (#1536 review): with the retired `\s+(.*)` form,
// the separator and payload both accepted whitespace, so a failing match
// re-split a long run quadratically. The public entry point can never feed
// the slow shape (trim strips edge whitespace and a per-line input carries no
// newline, so the old form matched greedily in one attempt there) — the
// regression surface is the pattern itself, pinned directly below; the
// entry-point case documents the behavior contract.
// ---------------------------------------------------------------------------

test('the annotation-line pattern rejects an interior-whitespace non-match in linear time', () => {
  // `x\n` tail: `.` cannot cross the newline and `$` needs true end-of-input,
  // so the match FAILS — the retired form re-tried every split of the tab run
  // (quadratic; multi-second at this size), while the `\S` anchor admits a
  // single split point.
  const adversarial = `#agent-device:target-v1${'\t'.repeat(100_000)}x\n`;
  const startedAt = Date.now();
  const match = TARGET_ANNOTATION_LINE_RE.exec(adversarial);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(match, null);
  assert.ok(elapsedMs < 1000, `expected linear rejection, took ${elapsedMs}ms`);
});

test('parseTargetAnnotationCommentLine still recognizes versions across an interior whitespace run', () => {
  const line = `#agent-device:target-v0\t${'\t\t'.repeat(20_000)}x`;
  assert.deepEqual(parseTargetAnnotationCommentLine(line), { kind: 'future-version' });
});
