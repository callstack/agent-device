// Case generators for the parser fuzz lane (#1414).
//
// fast-check rather than a bespoke PRNG, for two reasons the lane depends on: a reported
// counterexample is the SHRUNK input (a hand-rolled mutator reports the 20k-character random one),
// and the hazard vocabulary is curated beside the fuzzer so its config hash covers every input.
//
// Cases stay near the grammar's edge on purpose: a well-formed base with hostile chunks spliced in
// reaches deep parser branches that uniformly random noise never gets past the first token of.

import fc from 'fast-check';
import { replayScriptArb } from '../../src/__tests__/test-utils/property-arbitraries.ts';
import type { FuzzTarget, FuzzTargetName } from './target-types.ts';

const SELECTOR_VALUE_HAZARDS = [
  '',
  ' ',
  '"',
  "'",
  "it's",
  'say "hi"',
  '\\',
  String.raw`\"`,
  String.raw`a\\b`,
  'a || b',
  'key=value',
  'line\nbreak',
  '\tTab',
  'Ünïcøde',
  '😀 emoji',
] as const;

const TEXT_SELECTOR_KEYS = [
  'id',
  'role',
  'text',
  'label',
  'value',
  'appname',
  'windowtitle',
] as const;
const BOOLEAN_SELECTOR_KEYS = [
  'visible',
  'hidden',
  'editable',
  'selected',
  'focused',
  'enabled',
  'hittable',
] as const;

type FuzzSelectorTerm = { key: string; value: string | boolean };

const selectorTextValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SELECTOR_VALUE_HAZARDS),
  fc.string({ minLength: 0, maxLength: 12 }),
  fc
    .array(fc.constantFrom(...SELECTOR_VALUE_HAZARDS), { minLength: 2, maxLength: 3 })
    .map((parts) => parts.join('')),
);

const selectorTermArb: fc.Arbitrary<FuzzSelectorTerm> = fc.oneof(
  fc
    .record({
      key: fc.constantFrom(...TEXT_SELECTOR_KEYS),
      value: selectorTextValueArb,
    })
    .map(({ key, value }) => ({ key, value })),
  fc
    .record({
      key: fc.constantFrom(...BOOLEAN_SELECTOR_KEYS),
      value: fc.boolean(),
    })
    .map(({ key, value }) => ({ key, value })),
);

const selectorChainArb: fc.Arbitrary<{ expression: string }> = fc
  .record({
    selectors: fc.array(fc.array(selectorTermArb, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 3,
    }),
    bareBooleans: fc.boolean(),
  })
  .map(({ selectors, bareBooleans }) => ({
    expression: selectors
      .map((terms) =>
        terms
          .map((term) =>
            typeof term.value === 'boolean'
              ? bareBooleans && term.value
                ? term.key
                : `${term.key}=${term.value}`
              : `${term.key}=${JSON.stringify(term.value)}`,
          )
          .join(' && '),
      )
      .join(' || '),
  }));

/**
 * Hazards a valid-input property cannot use — they exist to be *rejected*: structural JSON/YAML
 * punctuation, delimiter lookalikes, prototype-pollution keys, numeric edges, bidi/zero-width
 * controls. The shared list above carries the ones valid inputs must also survive.
 */
const REJECTION_HAZARDS = [
  '`',
  '==',
  '&&',
  '--',
  '---',
  '#',
  ':',
  ',',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '${',
  '${}',
  '@',
  '~=',
  '*',
  '\r\n',
  '\u0000',
  '\u200b',
  '\u202e',
  '\ufeff',
  '-0',
  'NaN',
  'Infinity',
  '1e999',
  '9007199254740993',
  'null',
  'undefined',
  '__proto__',
  'constructor',
] as const;

const hazardArb: fc.Arbitrary<string> = fc.constantFrom(
  ...SELECTOR_VALUE_HAZARDS,
  ...REJECTION_HAZARDS,
);

/** A base string with 1–4 hazards spliced in at shrinkable positions. */
function corrupted(base: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(
      base,
      fc.array(fc.tuple(hazardArb, fc.nat({ max: 4096 })), { minLength: 1, maxLength: 4 }),
    )
    .map(([text, edits]) =>
      edits.reduce((current, [chunk, at]) => {
        const index = at % (current.length + 1);
        return current.slice(0, index) + chunk + current.slice(index);
      }, text),
    );
}

/** A long run of one hazard — regex-backtracking and quadratic-scan bait. */
const repeatedHazardArb: fc.Arbitrary<string> = fc
  .tuple(hazardArb, fc.integer({ min: 50, max: 400 }))
  .map(([chunk, times]) => chunk.repeat(times));

/** Input that is not trying to look like the grammar at all. */
const noiseArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.array(hazardArb, { maxLength: 8 }).map((parts) => parts.join('')),
  repeatedHazardArb,
);

/**
 * Bases borrowed from the property suite, which generates *valid* inputs: corrupting a
 * grammar-correct script or selector chain is how the fuzzer reaches branches past the first
 * rejection. Targets without one generate from their own seed list.
 */
const STRUCTURED_BASES: Partial<Record<FuzzTargetName, fc.Arbitrary<string>>> = {
  selector: selectorChainArb.map((chain) => chain.expression),
  'replay-script': replayScriptArb,
  'batch-steps': fc.json({ maxDepth: 3 }),
};

/** The case distribution for one target: mostly near-miss, some valid, some pure noise. */
export function arbitraryForTarget(target: FuzzTarget): fc.Arbitrary<string> {
  const seeded = fc.constantFrom(...target.seeds);
  const structured = STRUCTURED_BASES[target.name];
  const base = structured === undefined ? seeded : fc.oneof(seeded, structured);
  return fc.oneof(
    { weight: 6, arbitrary: corrupted(base) },
    { weight: 2, arbitrary: base },
    { weight: 2, arbitrary: noiseArb },
  );
}
